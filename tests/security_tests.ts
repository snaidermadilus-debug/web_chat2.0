import { io } from "socket.io-client";
import { strict as assert } from "assert";

async function runTests() {
  console.log("Running security tests...");
  const socket = io("http://localhost:3002");

  await new Promise<void>(r => socket.on("connect", () => r()));
  console.log("Connected to server.");

  // Test 1: Presenting admin key in join_group should not grant admin.
  socket.emit("create_group", { grupo_id: "testgrp1", usuario: "adminuser", device_id: "d1" });
  await new Promise(r => socket.on("group_result", r));
  
  socket.emit("join_group", { grupo_id: "testgrp1", usuario: "nonadmin", device_id: "d2", admin_key: "somekey" });
  const joinRes: any = await new Promise(r => socket.on("group_result", r));
  assert.strictEqual(joinRes.is_admin, false, "Test 1 Failed: Admin key in join_group granted admin");
  console.log("Test 1 Passed: Admin key in join_group did not grant admin.");

  // Test 2: leave_group cleanup
  socket.emit("leave_group", { grupo_id: "testgrp1", session_token: joinRes.session_token, device_id: "d2" });
  await new Promise(r => socket.on("left_group", r));
  console.log("Test 2 Passed: leave_group executed.");

  // Test 3: Identity Hijacking Prevention (same user, different device)
  socket.emit("create_group", { grupo_id: "testgrp2", usuario: "userA", device_id: "d1" });
  const res3: any = await new Promise(r => socket.on("group_result", r));
  
  // Try to join as "userA" but with different device_id using the token of "userA" on "d1"
  socket.emit("join_group", { grupo_id: "testgrp2", usuario: "userA", device_id: "d2", session_token: res3.session_token });
  const res3b: any = await new Promise(r => socket.on("group_result", r));
  // Based on current server.ts, this might be allowed because validSession checks device_id only if provided in auxiliaryDeviceId but here it's provided. Wait, validateSession returns null if device_id doesn't match!
  assert.strictEqual(res3b.success, false, "Test 3 Failed: Identity hijacking allowed");
  console.log("Test 3 Passed: Identity hijacking prevented.");

  console.log("All tests passed successfully.");
  process.exit(0);
}

runTests().catch(e => { console.error(e); process.exit(1); });
