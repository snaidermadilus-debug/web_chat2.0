import { io } from "socket.io-client";
import { strict as assert } from "assert";

const makeGroupId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 6)}`;
const waitForEvent = <T = any>(socket: any, eventName: string) => new Promise<T>((resolve) => socket.once(eventName, resolve));

async function runTests() {
  console.log("Running security tests...");
  const socket = io("http://localhost:3002");

  await new Promise<void>(r => socket.on("connect", () => r()));
  console.log("Connected to server.");

  const testGrp1 = makeGroupId("testgrp1");
  const testGrp2 = makeGroupId("testgrp2");
  const testGrp3 = makeGroupId("testgrp3");

  // Test 1: Presenting admin key in join_group should not grant admin.
  const createGroup1Promise = waitForEvent<any>(socket, "group_result");
  socket.emit("create_group", { grupo_id: testGrp1, usuario: "adminuser", device_id: "d1" });
  await createGroup1Promise;

  const joinGroupPromise = waitForEvent<any>(socket, "group_result");
  socket.emit("join_group", { grupo_id: testGrp1, usuario: "nonadmin", device_id: "d2", admin_key: "somekey" });
  const joinRes: any = await joinGroupPromise;
  assert.strictEqual(joinRes.is_admin, false, "Test 1 Failed: Admin key in join_group granted admin");
  console.log("Test 1 Passed: Admin key in join_group did not grant admin.");

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

  console.log("All tests passed successfully.");
  process.exit(0);
}

runTests().catch(e => { console.error(e); process.exit(1); });
