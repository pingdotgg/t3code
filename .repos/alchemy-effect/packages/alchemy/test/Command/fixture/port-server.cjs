// Fixture for Command.Dev `port` tests. Writes its PID + marker to PID_FILE,
// then listens on `PORT` without printing anything and stays alive.
//
// `LISTEN_DELAY_MS` -> how long to wait before listening (default 0). Lets the
//   test show readiness waits for the port, not for output or a deadline.
const fs = require("node:fs");
const net = require("node:net");

const pidFile = process.env.PID_FILE;
const marker = process.env.MARKER ?? "default";
const port = Number(process.env.PORT);

if (!pidFile || !port) {
  console.error("port-server.cjs: PID_FILE and PORT env vars are required");
  process.exit(1);
}

fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, marker }));

setTimeout(
  () => net.createServer((socket) => socket.end()).listen(port, "127.0.0.1"),
  Number(process.env.LISTEN_DELAY_MS ?? 0),
);
