// The Conn Server's SDK host: runs vendor SDKs (now Claude's Agent SDK) as the T3 server runs
// them, and speaks JSON lines with the Rust server. One process serves every SDK driver and
// every session. See PROTOCOL.md.
//
// Each driver lives in drivers/<name>.mjs and is imported the first time it is used. State is
// per open session and ends with it. Queues are bounded; stdout gives the backpressure.

import { once } from "node:events";
import { createInterface } from "node:readline";

/** Drivers by name; each is imported on first use. */
const DRIVER_MODULES = {
  claude: () => import("./drivers/claude.mjs"),
};
/** Open sessions, all drivers together. */
const MAX_SESSIONS = 256;
/** After the input closes, how long open sessions get to end before the host exits. */
const SHUTDOWN_GRACE_MS = 15_000;

// ---- output ----

let draining = null;

/** Writes one line. Returns a promise while stdout is full, so producers can wait. */
function write(value) {
  const ok = process.stdout.write(`${JSON.stringify(value)}\n`);
  if (!ok && draining === null) {
    draining = once(process.stdout, "drain").then(() => {
      draining = null;
    });
  }
  return draining;
}

/** Host log lines travel on their own channel. */
function log(level, text) {
  write({ ch: "log", level, text: `sdk-host: ${text}` });
}

function describeError(error) {
  if (error === null || typeof error !== "object") return { message: String(error) };
  const out = { message: typeof error.message === "string" ? error.message : String(error) };
  if (typeof error.errorClass === "string") out.errorClass = error.errorClass;
  if (typeof error.telemetryMessage === "string") out.telemetryMessage = error.telemetryMessage;
  return out;
}

// ---- drivers ----

const drivers = new Map();

function driver(name) {
  let loading = drivers.get(name);
  if (loading === undefined) {
    const load = DRIVER_MODULES[name];
    if (load === undefined) return Promise.reject(new Error(`unknown driver ${String(name)}`));
    loading = load().then((module) => module.createDriver({ describeError }));
    drivers.set(name, loading);
  }
  return loading;
}

// ---- sessions ----

/** sessionId → session handle. */
const sessions = new Map();

function openSession(command) {
  const { driver: name, instanceId, sessionId } = command;
  const tags = { driver: name, instanceId, sessionId };
  if (typeof sessionId !== "string" || sessions.has(sessionId) || sessions.size >= MAX_SESSIONS) {
    write({ ch: "sdk", t: "end", ...tags, error: { message: "the host cannot open this session" } });
    return;
  }
  let nextLocalId = 0;
  const session = {
    ...tags,
    pending: new Map(),
    ended: false,
    state: undefined,
    /** The driver object, once its module loaded. */
    impl: undefined,
    /** An SDK message. */
    emit: (message) => write({ ch: "sdk", t: "msg", ...tags, m: message }),
    /** Asks Rust; resolves with its `response`. */
    request: (kind, requestId, args, signal) =>
      new Promise((resolve, reject) => {
        const id = typeof requestId === "string" ? requestId : `host-${++nextLocalId}`;
        if (signal?.aborted || session.ended) return reject(new Error("aborted"));
        session.pending.set(id, { resolve, reject });
        signal?.addEventListener(
          "abort",
          () => {
            if (session.pending.delete(id)) {
              write({ ch: "sdk", t: "cancel", ...tags, id });
              reject(new Error("aborted"));
            }
          },
          { once: true },
        );
        write({ ch: "sdk", t: "request", ...tags, id, kind, args });
      }),
    end: (info) => {
      if (session.ended) return;
      session.ended = true;
      sessions.delete(sessionId);
      for (const pending of session.pending.values()) pending.reject(new Error("session ended"));
      session.pending.clear();
      write({ ch: "sdk", t: "end", ...tags, ...info });
      maybeExit();
    },
  };
  sessions.set(sessionId, session);
  session.ready = driver(name).then(
    (d) => {
      session.impl = d;
      if (shuttingDown) return session.end({ error: { message: "the host is stopping" } });
      d.open(session, command);
      if (session.closeRequested) closeSession(session).catch(() => {});
    },
    (error) => session.end({ error: describeError(error) }),
  );
}

function closeSession(session) {
  // A close that arrives while the driver loads runs right after the open.
  session.closeRequested = true;
  if (session.impl === undefined) return Promise.resolve();
  return session.impl.close(session);
}

// ---- commands ----

let shuttingDown = false;

function reply(id, promise) {
  promise.then(
    (value) => write({ ch: "reply", id, ok: true, value: value ?? null }),
    (error) => write({ ch: "reply", id, ok: false, error: describeError(error) }),
  );
}

/** Runs `use` once the session's driver has loaded and opened it. */
function withSession(command, use) {
  const session = sessions.get(command.sessionId);
  if (session === undefined) return Promise.reject(new Error("no such session"));
  return session.ready.then(() => {
    if (session.impl === undefined || session.ended) throw new Error("no such session");
    return use(session);
  });
}

function handle(command) {
  switch (command.t) {
    case "open":
      if (shuttingDown) {
        write({
          ch: "sdk",
          t: "end",
          driver: command.driver,
          instanceId: command.instanceId,
          sessionId: command.sessionId,
          error: { message: "the host is stopping" },
        });
        return;
      }
      openSession(command);
      return;
    case "input":
      reply(
        command.id,
        withSession(command, (s) => s.impl.input(s, command.message)),
      );
      return;
    case "call":
      reply(
        command.id,
        withSession(command, (s) =>
          s.impl.call(s, command.method, Array.isArray(command.args) ? command.args : []),
        ),
      );
      return;
    case "response": {
      const session = sessions.get(command.sessionId);
      const pending = session?.pending.get(command.id);
      if (pending === undefined) return;
      session.pending.delete(command.id);
      if (command.error !== undefined) pending.reject(new Error(String(command.error)));
      else pending.resolve(command.value ?? null);
      return;
    }
    case "close": {
      const session = sessions.get(command.sessionId);
      if (session !== undefined) {
        closeSession(session).catch((error) => log("warn", describeError(error).message));
      }
      return;
    }
    case "fn":
      reply(
        command.id,
        driver(command.driver).then((d) =>
          d.fn(command.name, Array.isArray(command.args) ? command.args : [], command.configDir),
        ),
      );
      return;
    case "shutdown":
      shutdown();
      return;
    default:
      log("warn", `unknown command ${String(command.t)}`);
  }
}

function maybeExit() {
  if (shuttingDown && sessions.size === 0) {
    process.stdout.end(() => process.exit(0));
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const session of sessions.values()) closeSession(session).catch(() => {});
  maybeExit();
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
}

process.on("unhandledRejection", (error) => log("error", `unhandled: ${describeError(error).message}`));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdout.on("error", () => process.exit(0));

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (line.length === 0) return;
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    log("warn", "dropped a line that is not JSON");
    return;
  }
  if (command === null || typeof command !== "object") return;
  try {
    handle(command);
  } catch (error) {
    log("error", describeError(error).message);
  }
});
input.on("close", shutdown);
write({ ch: "host", t: "ready", node: process.versions.node });
