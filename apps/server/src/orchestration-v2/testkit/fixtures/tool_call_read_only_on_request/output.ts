import { assert } from "@effect/vitest";
import type { OrchestrationV2TurnItem, ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertNoAcpClientFileOrTerminalRequests,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TOOL_CALL_WRITE_PROMPT,
} from "../shared.ts";

const PROBE_FILE = ".codex-probe-write-action.txt";
const PROBE_CONTENT = "codex app-server approval fixture";

// The prompt allows a shell command or a file edit, so the approval kind
// follows whichever tool the provider picked. What matters is the permission:
// a read-only sandbox with on-request approval must ask exactly once, the
// accepted request must resolve, and the approved tool must then run.
export function assertToolCallReadOnlyOnRequestOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [TOOL_CALL_WRITE_PROMPT]);

  assert.lengthOf(projection.runtimeRequests, 1, "the write must ask for permission exactly once");
  const request = projection.runtimeRequests[0];
  assert.equal(request?.status, "resolved");
  assert.equal(request?.decision, "accept");
  assert.include(["command", "file-change"], request?.kind);

  const approvals = projection.turnItems.flatMap((item) =>
    item.type === "approval_request" ? [item] : [],
  );
  assert.deepEqual(
    approvals.map((item) => [item.requestId, item.requestKind]),
    [[request?.id, request?.kind]],
    "the approval card must show the resolved request",
  );

  const writes = projection.turnItems.filter((item) =>
    request?.kind === "command"
      ? item.type === "command_execution" && item.input.includes(PROBE_FILE)
      : item.type === "file_change" && item.fileName.endsWith(PROBE_FILE),
  );
  assert.isNotEmpty(
    writes,
    `the approved ${request?.kind} must project a matching ${request?.kind === "command" ? "command_execution" : "file_change"} item`,
  );
  assert.isTrue(
    writes.some((item) => item.status === "completed"),
    "the approved write must complete",
  );
  // Grok's write reports an ACP v1 diff ({ path, oldText, newText }); the
  // file_change must still carry it, like the v2 patch form.
  for (const item of writes) {
    const content = writtenContent(item);
    assert.isDefined(content, `the approved ${item.type} must carry what it wrote`);
    assert.include(content, PROBE_CONTENT, "the approved write must carry the requested content");
  }
}

// T3 advertises no client fs or terminal to Grok, so Grok reads and writes the
// workspace itself and gates the write with its own permission prompt: T3
// answers that prompt (the shared assertion pins it as the only request) and
// never serves a file or terminal request.
export function assertToolCallReadOnlyOnRequestGrokOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertToolCallReadOnlyOnRequestOutput(result, transcript);
  assertNoAcpClientFileOrTerminalRequests(transcript);
  const permissionKinds = transcript.entries.flatMap((entry) => {
    if (entry.type !== "emit_inbound") return [];
    const frame = entry.frame as {
      method?: unknown;
      params?: { toolCall?: { kind?: unknown } };
    };
    return frame.method === "session/request_permission" ? [frame.params?.toolCall?.kind] : [];
  });
  assert.deepEqual(permissionKinds, ["edit"], "Grok must ask T3 before its own write");
}

function writtenContent(item: OrchestrationV2TurnItem): string | undefined {
  switch (item.type) {
    case "command_execution":
      return item.input;
    case "file_change":
      return item.newStr ?? item.diffStr;
    default:
      return undefined;
  }
}
