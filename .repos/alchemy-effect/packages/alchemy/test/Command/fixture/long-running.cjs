// Fixture used by DevCommand.test.ts. Writes its PID + a marker (so the test
// can tell two consecutive spawns apart) and then sleeps forever. The test
// uses `process.kill(pid, 0)` to assert liveness from the outside.
const fs = require("node:fs");

const file = process.env.PID_FILE;
const marker = process.env.MARKER ?? "default";

if (!file) {
  console.error("long-running.cjs: PID_FILE env var is required");
  process.exit(1);
}

fs.writeFileSync(file, JSON.stringify({ pid: process.pid, marker }));

// Hold the event loop open without doing any actual work.
setInterval(() => {}, 60_000);
