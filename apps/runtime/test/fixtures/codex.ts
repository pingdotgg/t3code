// External CLI fixture: speaks Codex's documented newline-delimited app-server RPC.
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.FAKE_CODEX_HOME!;
const threadsFile = join(home, "threads.json");
let persisted: string[] = [];
try { persisted = JSON.parse(readFileSync(threadsFile, "utf8")); } catch {}
const threads = new Set(persisted);
let sequence = 0;
let active: { threadId: string; id: string } | undefined;
let awaiting: "approval" | "question" | undefined;
const send = (frame: object) => process.stdout.write(JSON.stringify(frame) + "\n");
const event = (method: string, params: object) => send({ method, params });
const onSignal = (name: string, proceed: () => void) => {
  const timer = setInterval(() => {
    if (!existsSync(join(home, name))) return;
    clearInterval(timer); proceed();
  }, 10);
};
const complete = (status = "completed") => {
  if (!active) return;
  event("turn/completed", { threadId: active.threadId, turn: { id: active.id, status } });
  active = undefined;
};
const answer = (text: string) => {
  event("item/agentMessage/delta", { threadId: active!.threadId, itemId: `assistant-${active!.id}`, delta: text });
  complete();
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (!frame.method) {
    if (awaiting === "approval") {
      awaiting = undefined;
      answer(frame.result?.decision === "accept" ? "Command approved." : "Command declined.");
    } else if (awaiting === "question") {
      awaiting = undefined;
      answer(`Selected ${frame.result.answers.target.answers[0]}.`);
    }
    return;
  }
  const { id, method, params } = frame;
  const result = (value: object) => send({ id, result: value });
  if (method === "initialize") result({ userAgent: "fixture" });
  else if (method === "thread/start") {
    if (params.sandbox !== "read-only" && params.sandbox !== "danger-full-access") throw Error("Missing access mode");
    const threadId = `thread-${persisted.length}-${++sequence}`;
    threads.add(threadId);
    result({ thread: { id: threadId } });
  } else if (method === "thread/resume") {
    if (!persisted.includes(params.threadId)) send({ id, error: { message: "Thread has no persisted turn" } });
    else result({ thread: { id: params.threadId } });
  } else if (method === "turn/start") {
    if (!threads.has(params.threadId) || active) throw Error("Unknown thread or overlapping turn");
    active = { threadId: params.threadId, id: `turn-${++sequence}` };
    if (!persisted.includes(active.threadId)) {
      persisted.push(active.threadId); writeFileSync(threadsFile, JSON.stringify(persisted));
    }
    const prompt = params.input[0].text;
    event("turn/started", { threadId: active.threadId, turn: { id: active.id } });
    if (prompt === "Wait before acknowledgement") {
      const turnId = active.id;
      onSignal("acknowledge", () => result({ turn: { id: turnId } }));
    } else if (prompt !== "Delay start acknowledgement") result({ turn: { id: active.id } });
    if (prompt === "Wait for approval") {
      awaiting = "approval";
      send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: active.threadId, command: "git status" } });
    } else if (prompt === "Ask which target") {
      awaiting = "question";
      send({ id: "question-1", method: "item/tool/requestUserInput", params: { threadId: active.threadId,
        questions: [{ id: "target", header: "Target", question: "Which target?", options: [{ label: "Android" }, { label: "Web" }] }] } });
    } else if (prompt === "Crash provider") process.exit(42);
    else if (prompt === "Keep working" || prompt === "Delay start acknowledgement" || prompt === "Wait before acknowledgement") { /* Work waits for Stop or process shutdown. */ }
    else {
      event("item/agentMessage/delta", { threadId: active.threadId, itemId: `assistant-${active.id}`, delta: "The project " });
      event("item/started", { threadId: active.threadId, item: { id: "command", type: "commandExecution", command: "git status" } });
      event("item/commandExecution/outputDelta", { threadId: active.threadId, itemId: "command", delta: "working tree clean\n" });
      event("turn/diff/updated", { threadId: active.threadId, diff: "--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\n" });
      const finish = () => {
        event("item/completed", { threadId: active!.threadId, item: { id: "command", type: "commandExecution", command: "git status", status: "completed", aggregatedOutput: "working tree clean\n" } });
        answer("is ready.");
      };
      if (prompt === "Stream response") onSignal("finish-response", finish);
      else finish();
    }
  } else if (method === "turn/interrupt") {
    if (params.turnId !== active?.id || params.threadId !== active?.threadId) throw Error("Stop targeted the wrong turn");
    result({}); complete("interrupted");
  }
});
