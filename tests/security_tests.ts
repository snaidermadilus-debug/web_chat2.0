import { io } from "socket.io-client";
import { strict as assert } from "assert";
import bcrypt from "bcryptjs";

const makeGroupId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 6)}`;
const makeMessageId = () => `message_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const waitForEvent = <T = any>(socket: any, eventName: string) => new Promise<T>((resolve, reject) => {
  const timeout = setTimeout(() => {
    socket.off(eventName, listener);
    reject(new Error(`Timed out waiting for ${eventName}`));
  }, 10000);
  const listener = (data: T) => {
    clearTimeout(timeout);
    resolve(data);
  };
  socket.once(eventName, listener);
});
const expectNoEvent = (socket: any, eventName: string, durationMs = 250) => new Promise<boolean>((resolve) => {
  const listener = () => {
    clearTimeout(timeout);
    resolve(false);
  };
  const timeout = setTimeout(() => {
    socket.off(eventName, listener);
    resolve(true);
  }, durationMs);
  socket.once(eventName, listener);
});
const waitForGroupCount = (socket: any, grupoId: string) => new Promise<any>((resolve, reject) => {
  const timeout = setTimeout(() => {
    socket.off("user_count_update", listener);
    reject(new Error(`Timed out waiting for user count update for ${grupoId}`));
  }, 10000);
  const listener = (data: any) => {
    if (data.grupo_id !== grupoId) return;
    clearTimeout(timeout);
    socket.off("user_count_update", listener);
    resolve(data);
  };
  socket.on("user_count_update", listener);
});

const TEST_SERVER_URL = `http://localhost:${process.env.TEST_PORT || process.env.PORT || 3000}`;

async function runTests() {
  console.log("Running security tests...");
  const socket = io(TEST_SERVER_URL);

  await new Promise<void>(r => socket.on("connect", () => r()));
  console.log("Connected to server.");
  const db = await import("node:sqlite").then(({ DatabaseSync }) => new DatabaseSync(process.env.DATABASE_PATH || "chat_database.db"));

  const testGrp1 = makeGroupId("testgrp1");
  const testGrp2 = makeGroupId("testgrp2");
  const testGrp3 = makeGroupId("testgrp3");

  // Test 0: a private group cannot be created without a password.
  const privateNoPasswordGroup = makeGroupId("privateNoPassword");
  const privateNoPasswordPromise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: privateNoPasswordGroup, usuario: "privateowner", device_id: "d0", private: true, password: "  " });
  const privateNoPasswordResult = await privateNoPasswordPromise;
  assert.strictEqual(privateNoPasswordResult.success, false, "Test 0 Failed: private group was created without a password");
  const firstOnlineCountPromise = waitForGroupCount(socket, privateNoPasswordGroup);
  const reuseGroupIdPromise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: privateNoPasswordGroup, usuario: "publicowner", device_id: "d00" });
  const reuseGroupIdResult = await reuseGroupIdPromise;
  assert.strictEqual(reuseGroupIdResult.success, true, "Test 0 Failed: invalid private group creation reserved the group id");
  const firstOnlineCount = await firstOnlineCountPromise;
  assert.strictEqual(firstOnlineCount.count, 1, "Test 0 Failed: room presence did not count the creator");

  const secondSocket = io(TEST_SERVER_URL);
  await new Promise<void>(resolve => secondSocket.once("connect", () => resolve()));
  const secondOnlineCountPromise = waitForGroupCount(socket, privateNoPasswordGroup);
  const secondJoinPromise = waitForEvent<any>(secondSocket, "group_result");
  secondSocket.emit("join_group", { grupo_id: privateNoPasswordGroup, usuario: "countguest", device_id: "d01" });
  const secondJoin = await secondJoinPromise;
  assert.strictEqual(secondJoin.success, true, "Test 0 Failed: second socket could not join the room");
  const secondOnlineCount = await secondOnlineCountPromise;
  assert.strictEqual(secondOnlineCount.count, 2, "Test 0 Failed: room presence did not count the second socket");

  const messageId = makeMessageId();
  const senderMessagePromise = waitForEvent<any>(socket, "message_result");
  const participantMessagePromise = waitForEvent<any>(secondSocket, "receive_message");
  socket.emit("send_message", {
    grupo_id: privateNoPasswordGroup,
    usuario: "publicowner",
    session_token: reuseGroupIdResult.session_token,
    device_id: "d00",
    client_msg_id: messageId,
    msg: "button-send-integration"
  });
  const [senderMessage, participantMessage] = await Promise.all([senderMessagePromise, participantMessagePromise]);
  assert.strictEqual(senderMessage.success, true, "Test 0 Failed: send_message was not acknowledged");
  assert.strictEqual(senderMessage.client_msg_id, messageId, "Test 0 Failed: message_result did not match the client message");
  assert.strictEqual(participantMessage.msg, "button-send-integration", "Test 0 Failed: other participant did not receive the message");
  const sentGroupRow = db.prepare(`SELECT grupo_uuid FROM grupos WHERE grupo_id = ?`).get(privateNoPasswordGroup) as { grupo_uuid: string };
  const persistedMessage = db.prepare(`SELECT mensagem FROM mensagens WHERE grupo_uuid = ? AND client_msg_id = ?`).get(sentGroupRow.grupo_uuid, messageId) as { mensagem: string } | undefined;
  assert.strictEqual(persistedMessage?.mensagem, "button-send-integration", "Test 0 Failed: message was not persisted in SQLite");

  const disconnectedCountPromise = waitForGroupCount(socket, privateNoPasswordGroup);
  secondSocket.disconnect();
  const disconnectedCount = await disconnectedCountPromise;
  assert.strictEqual(disconnectedCount.count, 1, "Test 0 Failed: room presence was not refreshed after disconnect");

  const publicWithPasswordGroup = makeGroupId("publicWithPassword");
  const publicWithPasswordPromise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: publicWithPasswordGroup, usuario: "publicowner", device_id: "d02", password: "not-private" });
  const publicWithPasswordResult = await publicWithPasswordPromise;
  assert.strictEqual(publicWithPasswordResult.success, false, "Test 0 Failed: public group accepted a password");
  const publicWithoutPasswordPromise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: publicWithPasswordGroup, usuario: "publicowner", device_id: "d02" });
  const publicWithoutPasswordResult = await publicWithoutPasswordPromise;
  assert.strictEqual(publicWithoutPasswordResult.success, true, "Test 0 Failed: public group without a password could not be created");

  const privateWithPasswordGroup = makeGroupId("privateWithPassword");
  const privateWithPasswordPromise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: privateWithPasswordGroup, usuario: "privateowner", device_id: "d03", private: true, password: "private-pass" });
  const privateWithPasswordResult = await privateWithPasswordPromise;
  assert.strictEqual(privateWithPasswordResult.success, true, "Test 0 Failed: private group with a password could not be created");
  const privateGroupRow = db.prepare(`SELECT senha_hash, privado FROM grupos WHERE grupo_id = ?`).get(privateWithPasswordGroup) as { senha_hash: string; privado: number };
  assert.strictEqual(privateGroupRow.privado, 1, "Test 0 Failed: group with private option was not stored as private");
  assert.ok(bcrypt.compareSync("private-pass", privateGroupRow.senha_hash), "Test 0 Failed: private group password was not stored as a bcrypt hash");

  console.log("Test 0 Passed: group privacy/password combinations, bcrypt storage, and real-time persisted message delivery work.");

  // Test 1: Presenting admin key in join_group should not grant admin.
  const createGroup1Promise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: testGrp1, usuario: "adminuser", device_id: "d1" });
  await createGroup1Promise;

  const joinGroupPromise = waitForEvent<any>(socket, "group_result");
  socket.emit("join_group", { grupo_id: testGrp1, usuario: "nonadmin", device_id: "d2", admin_key: "somekey" });
  const joinRes: any = await joinGroupPromise;
  assert.strictEqual(joinRes.success, true, "Test 1 Failed: regular join did not succeed");
  assert.notStrictEqual(joinRes.is_admin, true, "Test 1 Failed: Admin key in join_group granted admin");
  console.log("Test 1 Passed: Admin key in join_group did not grant admin.");

  const unauthorizedDeletePromise = waitForEvent<any>(socket, "group_result");
  socket.emit("delete_group", { grupo_id: testGrp1, session_token: joinRes.session_token, device_id: "d2" });
  const unauthorizedDelete = await unauthorizedDeletePromise;
  assert.strictEqual(unauthorizedDelete.success, false, "Test 1 Failed: regular member deleted the group");

  // Test 2: leave_group cleanup
  const leaveGroupPromise = waitForEvent<any>(socket, "left_group");
  socket.emit("leave_group", { grupo_id: testGrp1, session_token: joinRes.session_token, device_id: "d2" });
  await leaveGroupPromise;
  console.log("Test 2 Passed: leave_group executed.");

  // Test 3: Identity Hijacking Prevention (same user, different device)
  const createGroup2Promise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: testGrp2, usuario: "userA", device_id: "d1" });
  const res3: any = await createGroup2Promise;

  // Try to join as "userA" but with different device_id using the token of "userA" on "d1"
  const hijackAttemptPromise = waitForEvent<any>(socket, "group_result");
  socket.emit("join_group", { grupo_id: testGrp2, usuario: "userA", device_id: "d2", session_token: res3.session_token });
  const res3b: any = await hijackAttemptPromise;
  // Based on current server.ts, this might be allowed because validSession checks device_id only if provided in auxiliaryDeviceId but here it's provided. Wait, validateSession returns null if device_id doesn't match!
  assert.strictEqual(res3b.success, false, "Test 3 Failed: Identity hijacking allowed");
  console.log("Test 3 Passed: Identity hijacking prevented.");

  // Test 4: Recovery token must be verified from the same device it was issued to.
  const createGroup3Promise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: testGrp3, usuario: "recoveryuser", device_id: "d9" });
  const res4Create: any = await createGroup3Promise;

  const recoveryRequestPromise = waitForEvent<any>(socket, "recovery_result");
  socket.emit("request_recovery", {
    grupo_id: testGrp3,
    usuario: "recoveryuser",
    recovery_secret: res4Create.recovery_secret,
    device_id: "d9"
  });
  const res4Request: any = await recoveryRequestPromise;
  assert.strictEqual(res4Request.success, true, "Test 4 Failed: request_recovery denied for valid secret");

  const recoveryVerifyPromise = waitForEvent<any>(socket, "recovery_verified");
  socket.emit("verify_recovery", {
    token: res4Request.token,
    grupo_id: testGrp3,
    usuario: "recoveryuser",
    device_id: "d10"
  });
  const res4Verify: any = await recoveryVerifyPromise;
  assert.strictEqual(res4Verify.success, false, "Test 4 Failed: recovery token was accepted from a different device");
  console.log("Test 4 Passed: Recovery token is bound to its device.");

  // Test 5: Successful recovery returns the full session metadata used by the client.
  const testGrp5 = makeGroupId("testgrp5");
  const createGroup5Promise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: testGrp5, usuario: "recoveruser2", device_id: "d15" });
  const res5Create: any = await createGroup5Promise;

  const reqRecovery5Promise = waitForEvent<any>(socket, "recovery_result");
  socket.emit("request_recovery", {
    grupo_id: testGrp5,
    usuario: "recoveruser2",
    recovery_secret: res5Create.recovery_secret,
    device_id: "d15"
  });
  const res5Request: any = await reqRecovery5Promise;

  const verifyRecovery5Promise = waitForEvent<any>(socket, "recovery_verified");
  socket.emit("verify_recovery", {
    token: res5Request.token,
    grupo_id: testGrp5,
    usuario: "recoveruser2",
    device_id: "d15"
  });
  const res5Verify: any = await verifyRecovery5Promise;
  assert.strictEqual(res5Verify.success, true, "Test 5 Failed: valid recovery was rejected");
  assert.strictEqual(res5Verify.grupo_id, testGrp5, "Test 5 Failed: group id missing after recovery");
  assert.strictEqual(res5Verify.usuario, "recoveruser2", "Test 5 Failed: user missing after recovery");
  assert.strictEqual(res5Verify.device_id, "d15", "Test 5 Failed: device id missing after recovery");
  console.log("Test 5 Passed: successful recovery returns the session metadata needed by the client.");

  // Test 5b: revoked sockets cannot receive later group broadcasts.
  const revokeGroup = makeGroupId("revoke");
  const createRevokeGroupPromise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: revokeGroup, usuario: "revokeuser", device_id: "revoke-device" });
  const revokeGroupResult = await createRevokeGroupPromise;
  const siblingSocket = io(TEST_SERVER_URL);
  const observerSocket = io(TEST_SERVER_URL);
  await Promise.all([
    new Promise<void>(resolve => siblingSocket.once("connect", () => resolve())),
    new Promise<void>(resolve => observerSocket.once("connect", () => resolve()))
  ]);
  const siblingJoinPromise = waitForEvent<any>(siblingSocket, "group_result");
  siblingSocket.emit("join_group", {
    grupo_id: revokeGroup,
    usuario: "revokeuser",
    session_token: revokeGroupResult.session_token,
    device_id: "revoke-device"
  });
  const siblingJoin = await siblingJoinPromise;
  assert.strictEqual(siblingJoin.success, true, "Test 5b Failed: second socket could not join with the shared session");
  const observerJoinPromise = waitForEvent<any>(observerSocket, "group_result");
  observerSocket.emit("join_group", { grupo_id: revokeGroup, usuario: "observer", device_id: "observer-device" });
  const observerJoin = await observerJoinPromise;
  assert.strictEqual(observerJoin.success, true, "Test 5b Failed: observer could not join group");

  const revokedPromise = waitForEvent<any>(siblingSocket, "session_revoked");
  const leaveRevokeGroupPromise = waitForEvent<any>(socket, "left_group");
  socket.emit("leave_group", {
    grupo_id: revokeGroup,
    session_token: revokeGroupResult.session_token,
    device_id: "revoke-device"
  });
  const leaveResult = await leaveRevokeGroupPromise;
  const revokedResult = await revokedPromise;
  assert.strictEqual(leaveResult.success, true, "Test 5b Failed: leaving the group failed");
  assert.strictEqual(revokedResult.reason, "left", "Test 5b Failed: sibling socket was not notified of revocation");

  const unexpectedMessage = expectNoEvent(siblingSocket, "receive_message");
  const observerMessagePromise = waitForEvent<any>(observerSocket, "message_result");
  observerSocket.emit("send_message", {
    grupo_id: revokeGroup,
    usuario: "observer",
    session_token: observerJoin.session_token,
    device_id: "observer-device",
    client_msg_id: makeMessageId(),
    msg: "active member message"
  });
  const observerMessage = await observerMessagePromise;
  assert.strictEqual(observerMessage.success, true, "Test 5b Failed: active member could not send a message");
  assert.strictEqual(await unexpectedMessage, true, "Test 5b Failed: revoked socket received a group message");

  const revokedSendPromise = waitForEvent<any>(siblingSocket, "message_result");
  siblingSocket.emit("send_message", {
    grupo_id: revokeGroup,
    usuario: "revokeuser",
    session_token: revokeGroupResult.session_token,
    device_id: "revoke-device",
    client_msg_id: makeMessageId(),
    msg: "must be rejected"
  });
  const revokedSend = await revokedSendPromise;
  assert.strictEqual(revokedSend.success, false, "Test 5b Failed: revoked session could still send messages");

  const staleGroup = makeGroupId("stale");
  const createStaleGroupPromise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: staleGroup, usuario: "staleowner", device_id: "stale-owner-device" });
  const staleGroupResult = await createStaleGroupPromise;
  assert.strictEqual(staleGroupResult.success, true, "Test 5b Failed: stale-session regression group could not be created");
  const staleSiblingJoinPromise = waitForEvent<any>(siblingSocket, "group_result");
  siblingSocket.emit("join_group", { grupo_id: staleGroup, usuario: "stalesibling", device_id: "stale-sibling-device" });
  const staleSiblingJoin = await staleSiblingJoinPromise;
  assert.strictEqual(staleSiblingJoin.success, true, "Test 5b Failed: sibling could not join stale-session regression group");
  const staleObserverJoinPromise = waitForEvent<any>(observerSocket, "group_result");
  observerSocket.emit("join_group", { grupo_id: staleGroup, usuario: "staleobserver", device_id: "stale-observer-device" });
  const staleObserverJoin = await staleObserverJoinPromise;
  assert.strictEqual(staleObserverJoin.success, true, "Test 5b Failed: observer could not join stale-session regression group");

  db.prepare("DELETE FROM sessoes WHERE session_token = ?").run(staleSiblingJoin.session_token);
  const staleRevocationPromise = waitForEvent<any>(siblingSocket, "session_revoked");
  const staleUnexpectedMessage = expectNoEvent(siblingSocket, "receive_message");
  const staleObserverMessagePromise = waitForEvent<any>(observerSocket, "message_result");
  observerSocket.emit("send_message", {
    grupo_id: staleGroup,
    usuario: "staleobserver",
    session_token: staleObserverJoin.session_token,
    device_id: "stale-observer-device",
    client_msg_id: makeMessageId(),
    msg: "message after session deletion"
  });
  const staleObserverMessage = await staleObserverMessagePromise;
  const staleRevocation = await staleRevocationPromise;
  assert.strictEqual(staleObserverMessage.success, true, "Test 5b Failed: active session could not send during stale-session regression");
  assert.strictEqual(staleRevocation.reason, "expired", "Test 5b Failed: invalid room socket was not revoked");
  assert.strictEqual(await staleUnexpectedMessage, true, "Test 5b Failed: invalid room socket received a group message");

  siblingSocket.disconnect();
  observerSocket.disconnect();
  console.log("Test 5b Passed: revocation blocks sending and stale room sockets cannot receive broadcasts.");

  // Test 6: repeated invalid joins must trigger rate limiting
  const testGrp6 = makeGroupId("testgrp6");
  const createGrp6Promise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: testGrp6, usuario: "ratelimituser", device_id: "d20", private: true, password: "correctpass" });
  const res6Create: any = await createGrp6Promise;
  assert.strictEqual(res6Create.success, true, "Test 6 Failed: could not create private group for rate-limit test");

  const responses: any[] = [];
  socket.on("group_result", (data) => responses.push(data));
  for (let i = 0; i < 11; i++) {
    socket.emit("join_group", { grupo_id: testGrp6, usuario: "ratelimituser", device_id: `d${i + 200}`, password: "wrongpass" });
  }
  await new Promise(r => setTimeout(r, 200));
  const blocked = responses.find((item) => item.msg === "Tente mais tarde.");
  assert.ok(blocked, "Test 6 Failed: repeated invalid join attempts did not trigger rate limiting");
  console.log("Test 6 Passed: repeated invalid join attempts hit the rate limit.");

  // Test 7: recovery token must be one-time use only
  const testGrp7 = makeGroupId("testgrp7");
  const createGrp7Promise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: testGrp7, usuario: "singleusetoken", device_id: "d30" });
  const res7Create: any = await createGrp7Promise;
  assert.strictEqual(res7Create.success, true, "Test 7 Failed: could not create group for single-use token test");

  const reqRecovery7Promise = waitForEvent<any>(socket, "recovery_result");
  socket.emit("request_recovery", {
    grupo_id: testGrp7,
    usuario: "singleusetoken",
    recovery_secret: res7Create.recovery_secret,
    device_id: "d30"
  });
  const res7Request: any = await reqRecovery7Promise;
  assert.strictEqual(res7Request.success, true, "Test 7 Failed: recovery request was denied");

  const verifyFirstPromise = waitForEvent<any>(socket, "recovery_verified");
  socket.emit("verify_recovery", {
    token: res7Request.token,
    grupo_id: testGrp7,
    usuario: "singleusetoken",
    device_id: "d30"
  });
  const res7FirstVerify: any = await verifyFirstPromise;
  assert.strictEqual(res7FirstVerify.success, true, "Test 7 Failed: valid recovery was rejected on first use");

  const verifySecondPromise = waitForEvent<any>(socket, "recovery_verified");
  socket.emit("verify_recovery", {
    token: res7Request.token,
    grupo_id: testGrp7,
    usuario: "singleusetoken",
    device_id: "d30"
  });
  const res7SecondVerify: any = await verifySecondPromise;
  assert.strictEqual(res7SecondVerify.success, false, "Test 7 Failed: token was reused after first verification");
  console.log("Test 7 Passed: recovery token is single-use only.");

  // Test 8: deleting a group must also remove orphaned history rows
  const testGrp8 = makeGroupId("testgrp8");
  const createGroup8Promise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: testGrp8, usuario: "cleanupuser", device_id: "d50" });
  const res8Create: any = await createGroup8Promise;
  assert.strictEqual(res8Create.success, true, "Test 8 Failed: could not create group for orphan cleanup regression");

  const groupRow = db.prepare(`SELECT grupo_uuid, admin_session_token FROM grupos WHERE grupo_id = ?`).get(testGrp8) as { grupo_uuid: string; admin_session_token: string } | undefined;
  assert.ok(groupRow, "Test 8 Failed: group row not found before cleanup check");
  assert.strictEqual(groupRow.admin_session_token, res8Create.session_token, "Test 8 Failed: creator admin session was not persisted");
  db.prepare(`INSERT INTO mensagens (grupo_uuid, usuario, mensagem, data_hora) VALUES (?, ?, ?, ?)`).run(groupRow.grupo_uuid, "ghostuser", "orphan message", new Date().toISOString());

  const groupDeletedPromise = waitForEvent<any>(socket, "group_deleted");
  socket.emit("delete_group", { grupo_id: testGrp8, session_token: res8Create.session_token, device_id: "d50" });
  await groupDeletedPromise;

  const remainingRows = db.prepare(`SELECT COUNT(*) as count FROM mensagens WHERE grupo_uuid = ?`).get(groupRow.grupo_uuid) as { count: number };
  assert.strictEqual(remainingRows.count, 0, "Test 8 Failed: orphaned messages remained after group deletion");
  console.log("Test 8 Passed: deleting a group removes orphaned history rows.");

  // Test 9: admin recovery must validate the key and bind admin rights to the new session.
  const testGrp9 = makeGroupId("testgrp9");
  const createGroup9Promise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: testGrp9, usuario: "adminrecover", device_id: "d60" });
  const res9Create: any = await createGroup9Promise;
  assert.strictEqual(res9Create.success, true, "Test 9 Failed: could not create group for admin recovery");

  const missingDeviceDeletePromise = waitForEvent<any>(socket, "group_result");
  socket.emit("delete_group", { grupo_id: testGrp9, session_token: res9Create.session_token });
  const missingDeviceDelete = await missingDeviceDeletePromise;
  assert.strictEqual(missingDeviceDelete.success, false, "Test 9 Failed: admin session was accepted without its device ID");

  const requestRecovery9Promise = waitForEvent<any>(socket, "recovery_result");
  socket.emit("request_recovery", {
    grupo_id: testGrp9,
    usuario: "adminrecover",
    recovery_secret: res9Create.recovery_secret,
    device_id: "d60"
  });
  const res9Request: any = await requestRecovery9Promise;
  assert.strictEqual(res9Request.success, true, "Test 9 Failed: admin recovery request was denied");

  const invalidAdminRecoveryPromise = waitForEvent<any>(socket, "recovery_verified");
  socket.emit("verify_recovery", {
    token: res9Request.token,
    grupo_id: testGrp9,
    usuario: "adminrecover",
    device_id: "d60",
    admin_key: "invalid-admin-key"
  });
  const invalidAdminRecovery: any = await invalidAdminRecoveryPromise;
  assert.strictEqual(invalidAdminRecovery.success, false, "Test 9 Failed: invalid admin key was accepted");

  const adminRecoveryPromise = waitForEvent<any>(socket, "recovery_verified");
  socket.emit("verify_recovery", {
    token: res9Request.token,
    grupo_id: testGrp9,
    usuario: "adminrecover",
    device_id: "d60",
    admin_key: res9Create.admin_key
  });
  const res9Recovery: any = await adminRecoveryPromise;
  assert.strictEqual(res9Recovery.success, true, "Test 9 Failed: valid admin recovery was rejected");
  assert.strictEqual(res9Recovery.is_admin, true, "Test 9 Failed: admin privileges were not returned");

  const recoveredGroup = db.prepare(`SELECT admin_session_token FROM grupos WHERE grupo_id = ?`).get(testGrp9) as { admin_session_token: string };
  assert.strictEqual(recoveredGroup.admin_session_token, res9Recovery.session_token, "Test 9 Failed: admin session was not transferred to the recovered session");
  const recoveredDeletePromise = waitForEvent<any>(socket, "group_deleted");
  socket.emit("delete_group", {
    grupo_id: testGrp9,
    session_token: res9Recovery.session_token,
    device_id: "d60"
  });
  await recoveredDeletePromise;
  console.log("Test 9 Passed: admin recovery validates the key and grants admin only to the recovered session.");

  // Test 10: heartbeat rejects sessions that exceeded the inactivity timeout.
  const testGrp10 = makeGroupId("testgrp10");
  const createGroup10Promise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: testGrp10, usuario: "inactiveuser", device_id: "d70" });
  const res10Create: any = await createGroup10Promise;
  const staleTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  db.prepare(`UPDATE sessoes SET last_seen = ?, expires_at = ? WHERE session_token = ?`)
    .run(staleTimestamp, new Date(Date.now() + 60 * 60 * 1000).toISOString(), res10Create.session_token);
  const staleHeartbeat = await new Promise<boolean>((resolve) => socket.emit("heartbeat", {
    grupo_id: testGrp10,
    session_token: res10Create.session_token,
    device_id: "d70"
  }, resolve));
  assert.strictEqual(staleHeartbeat, false, "Test 10 Failed: inactive session was accepted by heartbeat");
  const staleSession = db.prepare(`SELECT session_token FROM sessoes WHERE session_token = ?`).get(res10Create.session_token);
  assert.strictEqual(staleSession, undefined, "Test 10 Failed: expired inactive session was not deleted");
  console.log("Test 10 Passed: heartbeat expires sessions after 24 hours of inactivity.");

  // Test 11: activity refreshes the sliding expiry even if the old expires_at has passed.
  const testGrp11 = makeGroupId("testgrp11");
  const createGroup11Promise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: testGrp11, usuario: "activeuser", device_id: "d71" });
  const res11Create: any = await createGroup11Promise;
  db.prepare(`UPDATE sessoes SET last_seen = ?, expires_at = ? WHERE session_token = ?`)
    .run(new Date(Date.now() - 60 * 1000).toISOString(), new Date(Date.now() - 1000).toISOString(), res11Create.session_token);
  const activeHeartbeat = await new Promise<boolean>((resolve) => socket.emit("heartbeat", {
    grupo_id: testGrp11,
    session_token: res11Create.session_token,
    device_id: "d71"
  }, resolve));
  assert.strictEqual(activeHeartbeat, true, "Test 11 Failed: valid heartbeat was rejected");
  const refreshedSession = db.prepare(`SELECT expires_at FROM sessoes WHERE session_token = ?`).get(res11Create.session_token) as { expires_at: string };
  assert.ok(Date.parse(refreshedSession.expires_at) > Date.now(), "Test 11 Failed: activity did not extend the session expiry");
  console.log("Test 11 Passed: valid activity extends the inactivity deadline.");

  // Test 12: history is paginated and only available to a session bound to the requested group.
  const testGrp12 = makeGroupId("testgrp12");
  const createGroup12Promise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: testGrp12, usuario: "historyuser", device_id: "d80" });
  const res12Create: any = await createGroup12Promise;
  const historyMessageIds = [makeMessageId(), makeMessageId(), makeMessageId()];
  for (const [index, msg] of ["history-1", "history-2", "history-3"].entries()) {
    const sendMessagePromise = waitForEvent<any>(socket, "message_result");
    socket.emit("send_message", {
      grupo_id: testGrp12,
      usuario: "historyuser",
      session_token: res12Create.session_token,
      device_id: "d80",
      client_msg_id: historyMessageIds[index],
      msg
    });
    const sendResult: any = await sendMessagePromise;
    assert.strictEqual(sendResult.success, true, "Test 12 Failed: message could not be persisted");
  }

  const duplicateMessagePromise = waitForEvent<any>(socket, "message_result");
  socket.emit("send_message", {
    grupo_id: testGrp12,
    usuario: "historyuser",
    session_token: res12Create.session_token,
    device_id: "d80",
    client_msg_id: historyMessageIds[0],
    msg: "history-1"
  });
  const duplicateMessageResult: any = await duplicateMessagePromise;
  assert.strictEqual(duplicateMessageResult.success, true, "Test 12 Failed: retry of a persisted message was rejected");
  assert.strictEqual(duplicateMessageResult.duplicate, true, "Test 12 Failed: retry was not identified as a duplicate");
  const historyGroupRow = db.prepare(`SELECT grupo_uuid FROM grupos WHERE grupo_id = ?`).get(testGrp12) as { grupo_uuid: string };
  const historyMessageCount = db.prepare(`SELECT COUNT(*) as count FROM mensagens WHERE grupo_uuid = ?`).get(historyGroupRow.grupo_uuid) as { count: number };
  assert.strictEqual(historyMessageCount.count, 3, "Test 12 Failed: duplicate retry inserted an extra message");

  const firstHistoryPagePromise = waitForEvent<any>(socket, "history_result");
  socket.emit("load_history", {
    grupo_id: testGrp12,
    session_token: res12Create.session_token,
    device_id: "d80",
    limit: 2
  });
  const firstHistoryPage: any = await firstHistoryPagePromise;
  assert.strictEqual(firstHistoryPage.success, true, "Test 12 Failed: initial history page was rejected");
  assert.deepStrictEqual(firstHistoryPage.messages.map((message: any) => message.msg), ["history-2", "history-3"]);
  assert.strictEqual(firstHistoryPage.has_more, true, "Test 12 Failed: older history was not indicated");

  const olderHistoryPagePromise = waitForEvent<any>(socket, "history_result");
  socket.emit("load_history", {
    grupo_id: testGrp12,
    session_token: res12Create.session_token,
    device_id: "d80",
    before_id: firstHistoryPage.next_before_id,
    limit: 2
  });
  const olderHistoryPage: any = await olderHistoryPagePromise;
  assert.strictEqual(olderHistoryPage.success, true, "Test 12 Failed: older history page was rejected");
  assert.deepStrictEqual(olderHistoryPage.messages.map((message: any) => message.msg), ["history-1"]);
  assert.strictEqual(olderHistoryPage.has_more, false, "Test 12 Failed: final history page incorrectly reports more rows");

  const unauthorizedHistoryPromise = waitForEvent<any>(socket, "history_result");
  socket.emit("load_history", {
    grupo_id: testGrp1,
    session_token: res12Create.session_token,
    device_id: "d80"
  });
  const unauthorizedHistory: any = await unauthorizedHistoryPromise;
  assert.strictEqual(unauthorizedHistory.success, false, "Test 12 Failed: session accessed another group's history");
  console.log("Test 12 Passed: history pagination is ordered and bound to the authenticated group session.");

  // Test 13: oversized messages and per-session bursts are rejected.
  const testGrp13 = makeGroupId("testgrp13");
  const createGroup13Promise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: testGrp13, usuario: "sessionlimiter", device_id: "d90" });
  const res13Create: any = await createGroup13Promise;
  const oversizedMessagePromise = waitForEvent<any>(socket, "message_result");
  socket.emit("send_message", {
    grupo_id: testGrp13,
    usuario: "sessionlimiter",
    session_token: res13Create.session_token,
    device_id: "d90",
    client_msg_id: `${testGrp13}-oversized`,
    msg: "x".repeat(501)
  });
  const oversizedMessageResult: any = await oversizedMessagePromise;
  assert.strictEqual(oversizedMessageResult.success, false, "Test 13 Failed: oversized message was accepted");

  let sessionLimitResult: any;
  for (let index = 0; index < 9; index++) {
    const sendMessagePromise = waitForEvent<any>(socket, "message_result");
    socket.emit("send_message", {
      grupo_id: testGrp13,
      usuario: "sessionlimiter",
      session_token: res13Create.session_token,
      device_id: "d90",
      client_msg_id: `${testGrp13}-burst-${index}`,
      msg: `session-burst-${index}`
    });
    sessionLimitResult = await sendMessagePromise;
    assert.strictEqual(sessionLimitResult.success, index < 8, `Test 13 Failed: incorrect per-session limit at message ${index + 1}`);
  }
  assert.match(sessionLimitResult.msg, /Limite de mensagens/);
  console.log("Test 13 Passed: messages are size-limited and session bursts are throttled.");

  // Test 14: a room limit is shared across multiple valid sessions.
  const testGrp14 = makeGroupId("testgrp14");
  const createGroup14Promise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: testGrp14, usuario: "roomowner", device_id: "d91" });
  const res14Create: any = await createGroup14Promise;
  const group14Row = db.prepare(`SELECT grupo_uuid FROM grupos WHERE grupo_id = ?`).get(testGrp14) as { grupo_uuid: string };
  const roomSessions = [{ session_token: res14Create.session_token, usuario: "roomowner", device_id: "d91" }];
  for (let index = 1; index < 8; index++) {
    const session = {
      session_token: `${testGrp14}-session-${index}`,
      usuario: `roomuser${index}`,
      device_id: `d${91 + index}`
    };
    db.prepare(`INSERT INTO sessoes (session_token, grupo_uuid, usuario, device_id, expires_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(session.session_token, group14Row.grupo_uuid, session.usuario, session.device_id, new Date(Date.now() + 60 * 60 * 1000).toISOString(), new Date().toISOString());
    roomSessions.push(session);
  }

  let roomLimitResult: any;
  for (let index = 0; index < 61; index++) {
    const session = roomSessions[index % roomSessions.length];
    const sendMessagePromise = waitForEvent<any>(socket, "message_result");
    socket.emit("send_message", {
      grupo_id: testGrp14,
      usuario: session.usuario,
      session_token: session.session_token,
      device_id: session.device_id,
      client_msg_id: `${testGrp14}-burst-${index}`,
      msg: `room-burst-${index}`
    });
    roomLimitResult = await sendMessagePromise;
    assert.strictEqual(roomLimitResult.success, index < 60, `Test 14 Failed: incorrect room limit at message ${index + 1}`);
  }
  assert.match(roomLimitResult.msg, /Limite de mensagens/);
  console.log("Test 14 Passed: the room message limit is shared across sessions.");

  // Test 15: the IP limit is shared across groups and sessions.
  const testGrp15 = makeGroupId("testgrp15");
  const createGroup15Promise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: testGrp15, usuario: "ipowner", device_id: "d92" });
  const res15Create: any = await createGroup15Promise;
  const group15Row = db.prepare(`SELECT grupo_uuid FROM grupos WHERE grupo_id = ?`).get(testGrp15) as { grupo_uuid: string };
  const ipSessions = [{ session_token: res15Create.session_token, usuario: "ipowner", device_id: "d92" }];
  for (let index = 1; index < 8; index++) {
    const session = {
      session_token: `${testGrp15}-session-${index}`,
      usuario: `ipuser${index}`,
      device_id: `d${92 + index}`
    };
    db.prepare(`INSERT INTO sessoes (session_token, grupo_uuid, usuario, device_id, expires_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(session.session_token, group15Row.grupo_uuid, session.usuario, session.device_id, new Date(Date.now() + 60 * 60 * 1000).toISOString(), new Date().toISOString());
    ipSessions.push(session);
  }

  let ipLimitResult: any;
  for (let index = 0; index < 45; index++) {
    const session = ipSessions[index % ipSessions.length];
    const sendMessagePromise = waitForEvent<any>(socket, "message_result");
    socket.emit("send_message", {
      grupo_id: testGrp15,
      usuario: session.usuario,
      session_token: session.session_token,
      device_id: session.device_id,
      client_msg_id: `${testGrp15}-burst-${index}`,
      msg: `ip-burst-${index}`
    });
    ipLimitResult = await sendMessagePromise;
    assert.strictEqual(ipLimitResult.success, index < 42, `Test 15 Failed: incorrect IP limit at message ${index + 1}`);
  }
  assert.match(ipLimitResult.msg, /Limite de envio por IP/);
  console.log("Test 15 Passed: the IP message limit is shared across groups and sessions.");

  // Test 16: group creation attempts are limited even when they fail validation.
  let createLimitResult: any;
  for (let index = 0; index < 5; index++) {
    const createAttemptPromise = waitForEvent<any>(socket, "group_result");
    socket.emit("create_group", { grupo_id: testGrp15, usuario: "ratelimit", device_id: "ratelimit-device" });
    createLimitResult = await createAttemptPromise;
    if (index < 2) {
      assert.strictEqual(createLimitResult.msg, "Grupo já existe", "Test 16 Failed: valid creation attempt was rejected before the configured limit");
    } else {
      assert.strictEqual(createLimitResult.msg, "Tente mais tarde.", "Test 16 Failed: repeated group creation attempts were not limited");
    }
  }
  assert.strictEqual(createLimitResult.msg, "Tente mais tarde.", "Test 16 Failed: repeated group creation attempts were not limited");
  console.log("Test 16 Passed: group creation attempts are rate limited.");

  console.log("All tests passed successfully.");
  process.exit(0);
}

runTests().catch(e => { console.error(e); process.exit(1); });
