// Fixture for DevCommand URL-extraction tests. Writes its PID + marker to
// PID_FILE (so the test can stop the process if needed), then prints whatever
// is in `URL_LINE` to stdout/stderr and stays alive.
//
// `URL_LINE`  -> printed verbatim to stdout (can include ANSI escapes).
// `URL_STREAM` -> "stdout" (default) or "stderr".
// `URL_DELAY_MS` -> how long to wait before printing (default 0). Lets the
//   test exercise extraction that happens after reconcile starts awaiting.
// `URL_LINE_2` / `URL_STREAM_2` / `URL_DELAY_2_MS` -> an optional second line
//   printed independently. Lets a test print an unrelated URL first and the
//   real dev-server URL later (issue #695).
const fs = require("node:fs");

const pidFile = process.env.PID_FILE;
const marker = process.env.MARKER ?? "default";

if (!pidFile) {
  console.error("url-server.cjs: PID_FILE env var is required");
  process.exit(1);
}

fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, marker }));

const printLine = (line, streamEnv, delayEnv) => {
  if (!line) return;
  const stream = process.env[streamEnv] === "stderr" ? "stderr" : "stdout";
  const delayMs = Number(process.env[delayEnv] ?? 0);
  setTimeout(() => {
    process[stream].write(`${line}\n`);
  }, delayMs);
};

printLine(process.env.URL_LINE, "URL_STREAM", "URL_DELAY_MS");
printLine(process.env.URL_LINE_2, "URL_STREAM_2", "URL_DELAY_2_MS");

setInterval(() => {}, 60_000);
