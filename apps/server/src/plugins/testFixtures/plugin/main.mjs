// Misbehaves on request so PluginSupervisor.test.ts can exercise each failure path.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const IPC_FD = 3;

// Writes to the stderr it inherited until the write fails, then reports "closed" to the port.
const STDERR_HOLDER = `
const socket = require("node:net").connect(Number(process.argv[1]), "127.0.0.1");
const timer = setInterval(() => {
  try {
    require("node:fs").writeSync(2, "held\\n");
  } catch (error) {
    if (error.code !== "EPIPE") return;
    clearInterval(timer);
    socket.end("closed", () => process.exit(0));
  }
}, 10);
setTimeout(() => process.exit(1), 10_000);
`;

let holdDeactivate = false;
let log;

export function activate(context) {
  NodeFS.writeFileSync(NodePath.join(process.cwd(), "activated.marker"), String(process.pid));
  log = context.log;
  const handle = context.proposed.handle;
  handle("ping", (input) => ({ pid: process.pid, input }));
  // The next deactivation never finishes, so only a kill stops this process.
  handle("holdDeactivate", () => {
    holdDeactivate = true;
    return null;
  });
  handle("throws", () => {
    throw new Error("nope");
  });
  handle("spin", () => {
    for (;;) {}
  });
  handle(
    "cooperative",
    (_input, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("cancelled"));
          // Logged after the cancel's answer is written, so it arrives after it.
          setImmediate(() => log.info("cooperative-settled"));
        });
        log.info("cooperative-started");
      }),
  );
  handle("flood", (input) => {
    for (let index = 0; index < input.count; index++) log.debug("x".repeat(input.size));
    return { pid: process.pid, done: true };
  });
  // Ignores cancellation and never answers.
  handle("stall", () => new Promise(() => {}));
  // Ignores cancellation and answers anyway, after the server stopped waiting.
  handle(
    "late",
    (_input, { signal }) =>
      new Promise((resolve) => {
        context.log.info("late-started");
        signal.addEventListener("abort", () => resolve("late value"));
      }),
  );
  handle("exit", () => process.exit(3));
  // Starts a process that inherits stderr and outlives this plugin.
  handle("holdStderr", (input) => {
    const holder = NodeChildProcess.spawn(process.execPath, ["-e", STDERR_HOLDER, input.port], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    holder.unref();
    return { pid: holder.pid };
  });
  handle("oom", () => {
    const hog = [];
    for (;;) hog.push(Array.from({ length: 100_000 }, Math.random));
  });
  handle("bigResult", (input) => "x".repeat(input.bytes));
  // Results with no JSON form, which the child must answer with a failure.
  handle("functionResult", () => () => {});
  handle("symbolResult", () => Symbol("result"));
  handle("undefinedJsonResult", () => ({ toJSON: () => undefined }));
  handle("throwingJsonResult", () => ({
    toJSON() {
      throw new Error("x".repeat(3000));
    },
  }));
  handle("malformed", () => {
    NodeFS.writeSync(IPC_FD, "{not json}\n");
    return new Promise(() => {});
  });
  // fd 3 is non-blocking: keep writing one unterminated line until the server kills us.
  handle("oversizedFrame", (input) => {
    const data = Buffer.alloc(input.bytes, "x");
    for (let offset = 0; offset < data.length;) {
      try {
        offset += NodeFS.writeSync(IPC_FD, data, offset);
      } catch (error) {
        if (error.code !== "EAGAIN") throw error;
      }
    }
    return new Promise(() => {});
  });
}

export function deactivate() {
  if (!holdDeactivate) return;
  log.info("deactivate-held");
  return new Promise(() => {});
}
