// What Orbit's `swamp/ansible/t3_copy_rpc.mjs` does in a task copy, call by call, for the
// checks (`thread-cli-diff.mjs`, `orbit-flow.mjs`): read a waiting run's question, or stop
// that run, through the server's own WebSocket RPC.
//
// 1. `$HOME/.t3/userdata/server-runtime.json` names the origin.
// 2. `t3 auth session issue --scope orchestration:read [--scope orchestration:operate]
//    --ttl 1m --label "orbit copy turn" --json` issues the session; `sessionId` and `token`
//    come from its JSON.
// 3. `POST /api/auth/websocket-ticket` with the bearer token, then
//    `/ws?orchestrationProtocol=2&wsTicket=…`; frames are newline-separated JSON.
// 4. `orchestration.getThreadProjection` (`runs`, `runtimeRequests`, `turnItems`), and for an
//    interrupt `orchestration.dispatchCommand {type: "run.interrupt"}`, then reads until the
//    run is over.
// 5. `t3 auth session revoke <sessionId>`.
//
// The shape of the answer is the script's: `{runs, requests, stoppable}` for a read and
// `{interrupted, error, runs, pending}` for an interrupt.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const Over = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
const PollMs = 1000;
const ReadBytes = 150000;

const question = (asked) => ({
  id: String(asked.id ?? ""),
  header: String(asked.header ?? ""),
  question: String(asked.question ?? ""),
  options: (asked.options ?? []).map((option) => ({
    label: String(option.label ?? ""),
    description: String(option.description ?? ""),
    ...(option.value === undefined ? {} : { value: String(option.value) }),
  })),
  ...(asked.multiSelect === undefined ? {} : { multiSelect: asked.multiSelect === true }),
  ...(asked.allowCustomAnswer === undefined ? {} : { allowCustomAnswer: asked.allowCustomAnswer === true }),
  ...(asked.initialAnswer === undefined ? {} : { initialAnswer: String(asked.initialAnswer) }),
  ...(asked.required === undefined ? {} : { required: asked.required === true }),
});

const stoppable = (seen) =>
  seen.requests.length > 0 &&
  seen.requests.every((request) => request.kind === "user_input" && request.questions.length > 0);

/**
 * Runs the script's `read` or `interrupt` against `side` (`env.HOME`, and `cli(args)` that runs
 * that side's `t3` with `{stdout, stderr, code}`). Returns `{out, code, stderr, revoked}`.
 */
export async function copyRpc(side, command, threadId, runId, stored) {
  const deadline = Date.now() + 42_000;
  const left = () => Math.max(0, deadline - Date.now());
  const runtimeFile = NodePath.join(side.env.HOME, ".t3", "userdata", "server-runtime.json");
  const origin = JSON.parse(NodeFS.readFileSync(runtimeFile, "utf8")).origin;
  const scopes = command === "read" ? ["orchestration:read"] : ["orchestration:read", "orchestration:operate"];
  let issued = null;
  let socket = null;
  let out;
  let error = "";
  let revoked = false;
  try {
    const raw = await side.cli([
      "auth", "session", "issue", ...scopes.flatMap((scope) => ["--scope", scope]),
      "--ttl", "1m", "--label", "orbit copy turn", "--json",
    ]);
    if (raw.code !== 0) throw new Error(`issue exited ${raw.code}`);
    issued = JSON.parse(raw.stdout);
    const ticket = await fetch(`${origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}` },
      signal: AbortSignal.timeout(left()),
    });
    if (!ticket.ok) throw new Error(`T3 refused a WebSocket ticket (HTTP ${ticket.status}).`);
    socket = new WebSocket(
      `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent((await ticket.json()).ticket)}`,
    );
    const pending = new Map();
    let next = 0;
    socket.onmessage = (event) => {
      for (const line of String(event.data).split("\n").filter(Boolean)) {
        const frame = JSON.parse(line);
        if (frame._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
        if (frame._tag === "Exit" && pending.has(String(frame.requestId))) {
          pending.get(String(frame.requestId))(frame.exit);
        }
      }
    };
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error("T3 refused the RPC socket."));
    });
    const call = (tag, payload) =>
      new Promise((resolve, reject) => {
        const id = String(++next);
        const timer = setTimeout(() => reject(new Error(`T3 did not answer ${tag} in time.`)), left());
        pending.set(id, (exit) => {
          clearTimeout(timer);
          pending.delete(id);
          exit._tag === "Success"
            ? resolve(exit.value)
            : reject(new Error(`T3 answered ${tag} with ${JSON.stringify(exit).slice(0, 2000)}`));
        });
        socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      });
    const state = async () => {
      const projection = await call("orchestration.getThreadProjection", { threadId });
      const waiting = projection.runtimeRequests.filter((request) => request.status === "pending");
      const items = projection.turnItems.filter((item) => item.type === "user_input_request");
      return {
        runs: projection.runs.filter((run) => !Over.has(run.status)).map((run) => ({ id: run.id, status: run.status })),
        requests: waiting.map((request) => ({
          request_id: request.id,
          kind: request.kind,
          questions: (items.find((item) => item.requestId === request.id)?.questions ?? []).map(question),
        })),
      };
    };
    if (command === "read") {
      const seen = await state();
      out = { ...seen, stoppable: stoppable(seen) && Buffer.byteLength(JSON.stringify(seen)) < ReadBytes };
    } else {
      const live = (seen) => seen.runs.some((run) => run.id === runId);
      const wanted = [...new Set(stored.split("\n"))].sort();
      const before = await state();
      const asking = before.requests.map((request) => request.request_id).sort();
      let failure = null;
      if (live(before) && stoppable(before) && JSON.stringify(asking) === JSON.stringify(wanted)) {
        await call("orchestration.dispatchCommand", {
          type: "run.interrupt",
          commandId: `orbit:${crypto.randomUUID()}`,
          threadId,
          runId,
          reason: "Orbit ended the turn at its question; the answer comes as the next turn.",
        }).catch((cause) => {
          failure = cause.message;
        });
      } else {
        failure = "The run no longer waits for the stored questions: it was answered, or it asks something else.";
      }
      let after = await state();
      while (failure === null && live(after) && left() > 2 * PollMs) {
        await new Promise((resolve) => setTimeout(resolve, PollMs));
        after = await state();
      }
      out = { interrupted: failure === null && !live(after), error: failure, runs: after.runs, pending: after.requests.length };
    }
  } catch (cause) {
    error = cause.message;
  } finally {
    socket?.close();
    if (issued?.sessionId) {
      await side.cli(["auth", "session", "revoke", issued.sessionId]);
      const listed = await side.cli(["auth", "session", "list", "--json"]);
      try {
        revoked = !JSON.parse(listed.stdout).some((s) => s.sessionId === issued.sessionId);
      } catch {
        revoked = false;
      }
    }
  }
  return { out, code: error === "" ? 0 : 1, stderr: error, revoked };
}
