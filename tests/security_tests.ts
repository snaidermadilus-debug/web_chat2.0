import { io } from "socket.io-client";

async function runTests() {
  console.log("Running security tests...");
  const socket = io("http://localhost:3000");

  await new Promise<void>(r => socket.on("connect", () => r()));
  console.log("Connected to server.");

  // Test 1: Presenting admin key in join_group should not grant admin.
  socket.emit("create_group", { grupo_id: "testgrp", usuario: "adminuser", device_id: "d1" });
  await new Promise(r => socket.on("group_result", r));
  
  socket.emit("join_group", { grupo_id: "testgrp", usuario: "nonadmin", device_id: "d2", admin_key: "somekey" });
  const joinRes: any = await new Promise(r => socket.on("group_result", r));
  console.log("Test 1 Result (admin key in join_group should not grant admin):", joinRes.is_admin === false ? "PASS" : "FAIL");

  process.exit(0);
}

runTests().catch(e => { console.error(e); process.exit(1); });
