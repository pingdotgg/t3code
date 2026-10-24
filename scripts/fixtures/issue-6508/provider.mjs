// Deterministic Codex app-server peer: no tools, model calls, or filesystem actions.
import * as NodeReadline from "node:readline";
import * as NodeFS from "node:fs";
const args = new Set(process.argv.slice(2));
if (args.has("--version")) {
  console.log("codex-cli 0.159.0");
  process.exit(0);
}
if (args.has("mcp")) {
  console.log("[]");
  process.exit(0);
}
if (args.has("exec")) {
  console.log('{"title":"Fixture submission"}');
  process.exit(0);
}
const catalog = JSON.parse(NodeFS.readFileSync(new URL("./catalog.json", import.meta.url)));
const models = catalog.manifest.currentModels.codex.map((model, i) => ({
  id: model,
  model,
  displayName: model,
  description: "Frozen real catalog; deterministic provider fixture",
  hidden: false,
  isDefault: i === 0,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({
    reasoningEffort,
    description: reasoningEffort,
  })),
}));
const emit = (m) => console.log(JSON.stringify(m));
let thread;
for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    continue;
  }
  if (m.id === undefined) continue;
  const p = m.params ?? {};
  let result = {};
  switch (m.method) {
    case "initialize":
      result = {
        userAgent: "issue-6508-fixture",
        codexHome: process.cwd(),
        platformFamily: "unix",
        platformOs: "linux",
      };
      break;
    case "account/read":
      result = {
        account: { type: "chatgpt", email: "fixture@example.invalid", planType: "plus" },
        requiresOpenaiAuth: false,
      };
      break;
    case "account/rateLimits/read":
      result = { rateLimits: { primary: null, secondary: null, credits: null, planType: "plus" } };
      break;
    case "model/list":
      result = { data: models, nextCursor: null };
      break;
    case "skills/list":
      result = { data: [{ cwd: process.cwd(), skills: [], errors: [] }] };
      break;
    case "mcpServerStatus/list":
      result = { data: [], nextCursor: null };
      break;
    case "config/read":
      result = { config: {}, origins: {}, layers: [] };
      break;
    case "thread/start":
    case "thread/resume": {
      thread = {
        id: p.threadId ?? "fixture-native-thread",
        cliVersion: "0.159.0",
        createdAt: 1792663200,
        updatedAt: 1792663200,
        cwd: p.cwd ?? process.cwd(),
        ephemeral: true,
        modelProvider: "openai",
        preview: "",
        projectId: null,
        sessionId: "fixture-session",
        source: "appServer",
        status: { type: "idle" },
        turns: [],
      };
      result = {
        thread,
        model: p.model ?? models[0].model,
        modelProvider: "openai",
        cwd: thread.cwd,
        approvalPolicy: p.approvalPolicy ?? "never",
        approvalsReviewer: "user",
        sandbox: { type: "dangerFullAccess" },
        reasoningEffort: "high",
      };
      break;
    }
    case "thread/read":
      result = { thread };
      break;
    case "turn/start": {
      const turn = { id: "fixture-native-turn", items: [], status: "inProgress" };
      result = { turn };
      emit({ id: m.id, result });
      emit({ method: "turn/started", params: { threadId: p.threadId, turn } });
      const item = {
        id: "fixture-answer",
        type: "agentMessage",
        text: "Deterministic fixture response. No tools or real provider were run.",
      };
      emit({
        method: "item/started",
        params: { threadId: p.threadId, turnId: turn.id, item: { ...item, text: "" } },
      });
      emit({
        method: "item/agentMessage/delta",
        params: { threadId: p.threadId, turnId: turn.id, itemId: item.id, delta: item.text },
      });
      emit({ method: "item/completed", params: { threadId: p.threadId, turnId: turn.id, item } });
      emit({
        method: "turn/completed",
        params: { threadId: p.threadId, turn: { ...turn, status: "completed", items: [item] } },
      });
      continue;
    }
  }
  emit({ id: m.id, result });
}
