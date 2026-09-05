// A deterministic stdio peer for the real Codex session runtime. Each compact
// request advances one notification step; no clocks or model calls are used.
const readline = require("node:readline");
const threadId = "provider-monitor-thread";
const cwd = process.cwd();
const thread = {
  id: threadId,
  sessionId: threadId,
  forkedFromId: null,
  preview: "",
  ephemeral: true,
  modelProvider: "openai",
  createdAt: 1,
  updatedAt: 1,
  status: { type: "idle" },
  path: null,
  cwd,
  cliVersion: "0.153.2",
  source: "vscode",
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns: [],
};
const command = {
  id: "watch-command",
  type: "commandExecution",
  processId: "42",
  source: "unifiedExecStartup",
  command: "watch-ci",
  commandActions: [{ type: "unknown", command: "watch-ci" }],
  cwd,
  status: "inProgress",
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
};
let active;
let original;
let scenario;
let serial = 0;
let step = 0;
let cleanCount = 0;
let interrupted = 0;
let wakeRejected = false;
const wakes = [];
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) =>
  write({
    method,
    params: {
      ...(method === "item/started" ? { startedAtMs: 1000 } : {}),
      ...(method === "item/completed" ? { completedAtMs: 2000 } : {}),
      ...params,
    },
  });
const reply = (id, result) => write({ id, result });
const turn = (id, status) => ({ id, status, items: [], error: null });
const finish = (id) => {
  active = undefined;
  notify("turn/completed", { threadId, turn: turn(id, "completed") });
};
const output = (delta) =>
  notify("item/commandExecution/outputDelta", {
    threadId,
    turnId: original,
    itemId: command.id,
    delta,
  });
const barrier = () => notify("thread/name/updated", { threadId, threadName: `barrier-${step}` });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  switch (method) {
    case "initialize":
      reply(id, {
        codexHome: cwd,
        platformFamily: "unix",
        platformOs: "linux",
        userAgent: `t3/${process.env.T3_MONITOR_TEST_VERSION ?? "0.153.2"} (test)`,
      });
      break;
    case "thread/start":
      reply(id, {
        thread,
        model: "gpt-test",
        modelProvider: "openai",
        cwd,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "dangerFullAccess" },
        reasoningEffort: null,
      });
      break;
    case "config/mcpServer/reload":
      if (scenario === "stall-reload") barrier();
      else reply(id, {});
      break;
    case "turn/start": {
      if (params.input?.[0]?.text === "reject-resume") {
        write({ id, error: { code: -32603, message: "Resume rejected" } });
        break;
      }
      if (params.input?.[0]?.text === "timeout-resume") {
        barrier();
        break;
      }
      if (scenario === "stall-turn") {
        barrier();
        break;
      }
      if (params.toolOutput && scenario === "timeout-wake") {
        barrier();
        break;
      }
      if (params.toolOutput && scenario === "reject-wake" && !wakeRejected) {
        wakeRejected = true;
        write({ id, error: { code: -32603, message: "Wake rejected" } });
        break;
      }
      active = `turn-${++serial}`;
      reply(id, { turn: turn(active, "inProgress") });
      notify("turn/started", { threadId, turn: turn(active, "inProgress") });
      if (params.toolOutput) {
        wakes.push(params.toolOutput);
        finish(active);
      } else {
        original = active;
        scenario = params.input[0]?.text;
        if (serial === 1) notify("item/started", { threadId, turnId: active, item: command });
        if (scenario !== "busy" && scenario !== "cleanup-failure" && !scenario.startsWith("stall-"))
          finish(active);
      }
      break;
    }
    case "thread/compact/start":
      step++;
      reply(id, {});
      if (scenario === "busy" && step === 2) finish(original);
      else if (scenario === "exit") {
        output("partial");
        notify("item/completed", {
          threadId,
          turnId: original,
          item: { ...command, status: "completed", exitCode: 0 },
        });
      } else if (scenario === "child") {
        notify("item/commandExecution/outputDelta", {
          threadId: "foreign-child",
          turnId: original,
          itemId: command.id,
          delta: "child event\n",
        });
      } else output("CI passed\n");
      barrier();
      break;
    case "thread/backgroundTerminals/clean":
      cleanCount++;
      if (scenario === "cleanup-failure") {
        write({ id, error: { code: -32603, message: "Cleanup failed" } });
      } else {
        reply(id, {});
        output("shutdown output\n");
        notify("item/completed", {
          threadId,
          turnId: original,
          item: { ...command, status: "failed", exitCode: -1 },
        });
      }
      break;
    case "turn/interrupt":
      interrupted++;
      reply(id, {});
      finish(params.turnId);
      break;
    case "thread/read":
      reply(id, {
        thread: {
          ...thread,
          turns: [
            {
              ...turn("inspection", "completed"),
              items: [
                {
                  type: "agentMessage",
                  id: "inspection-message",
                  memoryCitation: null,
                  text: JSON.stringify({ wakes, cleanCount, interrupted }),
                },
              ],
            },
          ],
        },
      });
      break;
    default:
      write({ id, error: { code: -32601, message: method } });
  }
});
