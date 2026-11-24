import { DatabaseSync } from "node:sqlite";

const active = new Set(["preparing", "starting", "running", "waiting"]);
const stepTypes = new Set(["command_execution", "file_change", "file_search", "web_search"]);

function stripShellPrefix(input = "") {
  return input
    .replace(/^"?[^"]*?(?:pwsh|powershell)(?:\.exe)?"?\s+-Command\s+/i, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

function commandLabel(input = "") {
  const clean = stripShellPrefix(input);
  if (/\b(?:test|vitest|pytest|gradlew?\s+test)\b/i.test(clean)) {
    return /cadastro/i.test(clean) ? "Rodando testes de cadastro" : "Rodando testes";
  }
  return clean.slice(0, 180);
}

function operation(item) {
  if (!item) return "";
  switch (item.type) {
    case "command_execution": return commandLabel(item.input);
    case "file_change": return "Editando " + item.fileName;
    case "file_search": return "Buscando " + (item.pattern || "arquivos");
    case "web_search": return "Pesquisando " + (item.patterns?.[0] || item.query || "na web");
    default: return item.title || "";
  }
}

export function toSnapshot({ id, revision, messages, run, items, requests }) {
  const latest = items.filter(item => item.runId === run?.id);
  const open = requests.find(request => request.status === "pending");
  const requestedItem = open && items.find(item => item.requestId === open.id);
  const question = requestedItem?.questions?.[0];
  const workingOn = latest.findLast(item => item.status === "running" && operation(item));
  const streaming = messages.some(msg => msg.runId === run?.id && msg.role === "assistant" && msg.streaming);
  const rawPrompt = question?.question || requestedItem?.reason || requestedItem?.prompt || "A operação requer sua aprovação.";
  const cleanPrompt = rawPrompt.replace(/^"?[^"]*?(?:pwsh|powershell)(?:\.exe)?"?\s+-Command\s+/i, "PowerShell · ");
  const pending = !open ? null : {
    id: open.id,
    kind: open.kind === "user_input" ? "question" : "approval",
    text: cleanPrompt,
    options: question?.options.map(option => option.label) ?? [],
    questions: requestedItem?.questions ?? [],
  };
  const steps = latest
    .filter(item => stepTypes.has(item.type) && operation(item))
    .slice(-4)
    .map(item => ({ id: item.id, label: operation(item), done: item.status !== "running" }));
  let status = "idle";
  let detail = "";
  if (pending) {
    status = "pending";
    detail = pending.kind === "question" ? "Pergunta pendente" : "Aprovação pendente";
  } else if (run?.status === "failed") {
    status = "error";
    detail = run.failure?.message || "A execução falhou";
  } else if (active.has(run?.status)) {
    status = streaming ? "responding" : "working";
    detail = streaming ? "" : operation(workingOn);
  } else if (run?.status === "interrupted" || run?.status === "cancelled") {
    detail = "Execução interrompida";
  }
  return {
    id, revision, status, detail, steps, pending,
    messages: messages.filter(msg => msg.role === "user" || msg.role === "assistant")
      .map(({ id, role, text }) => ({ id, role, text })),
  };
}

// T3 owns the projection and all writes. One WAL read transaction returns a coherent
// revision across messages, activities and approvals, including after a reconnect.
export function openProjection(path) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
  const project = db.prepare("SELECT project_id, payload_json FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1").get();
  if (!project) throw Error("Inicie o T3 com um projeto de demonstração.");
  const defaults = { projectId: project.project_id, modelSelection: JSON.parse(project.payload_json).modelSelection };
  const exists = db.prepare("SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ? AND project_id = ? AND deleted_at IS NULL");
  const latest = db.prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id = ? ORDER BY CASE WHEN status IN ('preparing','running','starting','waiting') THEN 0 WHEN status = 'queued' THEN 2 ELSE 1 END, ordinal DESC LIMIT 1");
  const messages = db.prepare("SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id = ? ORDER BY created_at, rowid");
  const items = db.prepare("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id = ? AND (run_id = ? OR type IN ('approval_request','user_input_request')) ORDER BY ordinal");
  const requests = db.prepare("SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE thread_id = ? AND status = 'pending' ORDER BY created_at");
  const sequence = db.prepare("SELECT last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name = 'thread-projections'");
  function read(id) {
    db.exec("BEGIN");
    try {
      const revision = sequence.get()?.last_sequence || 0;
      const runRow = latest.get(id);
      const run = runRow ? JSON.parse(runRow.payload_json) : null;
      const records = rows => rows.map(row => JSON.parse(row.payload_json));
      const snapshot = toSnapshot({
        id, revision, run, messages: records(messages.all(id)), requests: records(requests.all(id)),
        items: records(items.all(id, run?.id || "")),
      });
      return { snapshot, exists: !!exists.get(id, project.project_id), run };
    } finally { db.exec("COMMIT"); }
  }
  return { read, defaults };
}
