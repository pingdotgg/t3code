// Minimal codex app-server stand-in for runtime-level collab tests.
// Speaks just enough of the protocol for CodexSessionRuntime to start a
// session, using REAL captured responses (codexMultiAgentWire.json), then
// replays a scripted multi-agent notification sequence read from the
// T3_CODEX_COLLAB_SCRIPT env var (a JSON file path) when the first turn
// starts. Runs as a plain Node process — stdlib only.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  NodeFS.readFileSync(NodePath.join(here, "codexMultiAgentWire.json"), "utf8"),
);
const script = JSON.parse(NodeFS.readFileSync(process.env.T3_CODEX_COLLAB_SCRIPT, "utf8"));

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const appendSidecar = (suffix, entry) =>
  NodeFS.appendFileSync(
    `${process.env.T3_CODEX_COLLAB_SCRIPT}.${suffix}`,
    `${JSON.stringify(entry)}\n`,
  );
let turnStartCount = 0;
/** Turn id the thread is currently running, mirroring the app-server's own
 * precondition state: `turn/steer` is only accepted against this id. */
let activeTurnId;
let steerCount = 0;

const rl = NodeReadline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = message;
  if (method === "initialize") {
    write({
      id,
      result: {
        userAgent: "t3-collab-mock/0.0.0",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    return;
  }
  if (method === "thread/start" || method === "thread/resume") {
    write({ id, result: fixture.responses.threadStart });
    return;
  }
  if (method === "turn/start") {
    const turnId = script.turnIds?.[turnStartCount];
    const turn = turnId
      ? { ...fixture.responses.turnStart.turn, id: turnId }
      : fixture.responses.turnStart.turn;
    turnStartCount += 1;
    appendSidecar("starts", { turnId: turn.id, input: message.params?.input });
    const rootThreadId = script.rootThreadId;
    // `turn/started` normally follows the response, but the notification can
    // win the race on a real app-server. `turnStartedBeforeResponse` replays
    // that ordering, and `startedTurnIdOverride` lets it name a different id
    // than the response so the runtime's preference between the two is
    // actually observable.
    const startedTurn = script.startedTurnIdOverride
      ? { ...turn, id: script.startedTurnIdOverride }
      : turn;
    if (activeTurnId !== undefined) {
      // Captured codex-cli 0.147.0 behavior: mid-turn `turn/start` returns a
      // different phantom id but folds the user message into the active turn.
      // It does not start a second lifecycle and must not replace the active
      // id the peer validates for steer/interrupt.
      write({ id, result: { ...fixture.responses.turnStart, turn } });
      const foldedItem = {
        id: `mid-turn-start-item-${turnStartCount}`,
        type: "userMessage",
        text: message.params?.input?.find((entry) => entry.type === "text")?.text ?? "",
      };
      for (const itemMethod of ["item/started", "item/completed"]) {
        write({
          jsonrpc: "2.0",
          method: itemMethod,
          params: { threadId: script.rootThreadId, turnId: activeTurnId, item: foldedItem },
        });
      }
      return;
    }
    // The server validates steer/interrupt against the id it RETURNS, even
    // when the notification publishes another one (captured `/review`
    // behaviour), so the response id is the authoritative active turn here.
    activeTurnId = turn.id;
    const writeTurnStarted = () =>
      write({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { threadId: rootThreadId, turn: startedTurn },
      });
    if (script.turnStartedBeforeResponse === true) {
      writeTurnStarted();
      write({ id, result: { ...fixture.responses.turnStart, turn } });
    } else {
      write({ id, result: { ...fixture.responses.turnStart, turn } });
      writeTurnStarted();
    }
    for (const notification of script.notifications) {
      write({ jsonrpc: "2.0", method: notification.method, params: notification.params });
    }
    if (script.holdTurnOpen !== true) {
      activeTurnId = undefined;
      write({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: rootThreadId,
          turn: { ...turn, status: "completed" },
        },
      });
    }
    return;
  }
  if (method === "turn/steer") {
    // Record the steer (append-only sidecar the test reads) so mid-turn send
    // coverage can assert the message folded into the running turn.
    steerCount += 1;
    appendSidecar("steers", {
      threadId: message.params?.threadId,
      expectedTurnId: message.params?.expectedTurnId,
      input: message.params?.input,
    });
    if (script.endTurnBeforeFirstSteer === true && steerCount === 1) {
      const endedTurnId = activeTurnId;
      activeTurnId = undefined;
      write({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: script.rootThreadId,
          turn: { ...fixture.responses.turnStart.turn, id: endedTurnId, status: "completed" },
        },
      });
    }
    if (script.deferStaleSteerResponses === true && activeTurnId === undefined) {
      setImmediate(() => {
        write({ id, error: { code: -32600, message: "no active turn to steer" } });
      });
      return;
    }
    // `steerRejectAfter` lets a script serve N steers then refuse.
    const rejectNow =
      script.steerRejection &&
      (script.steerRejectAfter === undefined || steerCount > script.steerRejectAfter);
    if (rejectNow) {
      write({ id, error: script.steerRejection });
      return;
    }
    // expectedTurnId is a precondition on the real app-server. Both refusals
    // are quoted from captured transcripts (codex-cli 0.147.0): bare
    // `{code: -32600, message}`, with no `data` and no structured error info.
    if (activeTurnId === undefined) {
      write({ id, error: { code: -32600, message: "no active turn to steer" } });
      return;
    }
    if (message.params?.expectedTurnId !== activeTurnId) {
      write({
        id,
        error: {
          code: -32600,
          message: `expected active turn id \`${message.params?.expectedTurnId}\` but found \`${activeTurnId}\``,
        },
      });
      return;
    }
    // Captured shape (codex-cli 0.147.0): the steered message joins the
    // running turn as a `userMessage` item with both `item/started` and
    // `item/completed` carrying the ORIGINAL turn id, and the response
    // echoes that same id. The turn keeps running and completes once.
    const steerItem = {
      id: `steer-item-${steerCount}`,
      type: "userMessage",
      text: message.params?.input?.find((entry) => entry.type === "text")?.text ?? "",
    };
    for (const itemMethod of ["item/started", "item/completed"]) {
      write({
        jsonrpc: "2.0",
        method: itemMethod,
        params: { threadId: script.rootThreadId, turnId: activeTurnId, item: steerItem },
      });
    }
    write({ id, result: { turnId: activeTurnId } });
    if (script.completeTurnAfterSteer === true) {
      const steeredTurn = { ...fixture.responses.turnStart.turn, id: activeTurnId };
      activeTurnId = undefined;
      write({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId: script.rootThreadId, turn: { ...steeredTurn, status: "completed" } },
      });
    }
    return;
  }
  if (method === "turn/interrupt") {
    // Record which thread/turn was interrupted (append-only sidecar file the
    // test reads) so Stop coverage can assert every live child was reached.
    // failInterruptFor simulates a dead child whose interrupt errors.
    const target = message.params?.threadId;
    NodeFS.appendFileSync(
      `${process.env.T3_CODEX_COLLAB_SCRIPT}.interrupts`,
      `${JSON.stringify({ threadId: target, turnId: message.params?.turnId })}\n`,
    );
    if (
      script.expectedActiveTurnId &&
      message.params?.threadId === script.rootThreadId &&
      message.params?.turnId !== script.expectedActiveTurnId
    ) {
      write({
        id,
        error: {
          code: -32000,
          message: `expected active turn id ${message.params?.turnId} but found ${script.expectedActiveTurnId}`,
        },
      });
      return;
    }
    if (script.failInterruptFor && script.failInterruptFor === target) {
      write({ id, error: { code: -32000, message: "thread already closed" } });
      return;
    }
    if (script.hangInterruptFor && script.hangInterruptFor === target) {
      // Never respond: simulates a wedged child whose RPC neither resolves
      // nor rejects. The runtime's bounded deadline must move on.
      return;
    }
    write({ id, result: {} });
    return;
  }
  if (id !== undefined) {
    write({ id, result: {} });
  }
});
