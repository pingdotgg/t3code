import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkLogEntries } from "./session-logic";
import { workEntryDisplayLabel } from "./components/chat/MessagesTimeline.logic";

// These are the already-truncated fields emitted by ProviderRuntimeIngestion
// for the malformed-skill diagnostic reported in issue 1084.
const retainedMessage =
  "2026-03-14T16:11:12.550224Z ERROR codex_core::codex: failed to load skill /home/sebherrerabe/repos/devsuite/.agent/skills/monorepo-scaffolding/SKILL.md: invalid YAML: mapping va...";
const warningSummary =
  "2026-03-14T16:11:12.550224Z ERROR codex_core::codex: failed to load skill /home/sebherrerabe/repos/devsuite/.agent/sk...";

function makeActivity(
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make("diagnostic"),
    createdAt: "2026-09-05T00:00:00.000Z",
    kind: "runtime.error",
    tone: "error",
    summary: "Runtime error",
    payload: { message: retainedMessage },
    turnId: TurnId.make("turn-1"),
    ...overrides,
  };
}

describe("runtime diagnostics in the work log", () => {
  it("shows the retained error message in place of its generic row label", () => {
    const [entry] = deriveWorkLogEntries([makeActivity()]);

    expect(entry).toMatchObject({ label: "Runtime error", detail: retainedMessage });
    expect(entry && workEntryDisplayLabel(entry, undefined)).toBe(retainedMessage);
  });

  it("shows the retained warning message beyond its truncated label", () => {
    const [entry] = deriveWorkLogEntries([
      makeActivity({ kind: "runtime.warning", tone: "info", summary: warningSummary }),
    ]);

    expect(entry).toMatchObject({ label: warningSummary, detail: retainedMessage });
    expect(entry && workEntryDisplayLabel(entry, undefined)).toBe(retainedMessage);
  });

  it("keeps an existing diagnostic detail when one is provided", () => {
    const [entry] = deriveWorkLogEntries([
      makeActivity({ payload: { message: retainedMessage, detail: "Run claude auth login." } }),
    ]);

    expect(entry?.detail).toBe("Run claude auth login.");
  });

  it("does not repeat a short warning already visible in the label", () => {
    const [entry] = deriveWorkLogEntries([
      makeActivity({
        kind: "runtime.warning",
        tone: "info",
        summary: "Reconnecting... 2/5",
        payload: { message: "Reconnecting... 2/5" },
      }),
    ]);

    expect(entry?.label).toBe("Reconnecting... 2/5");
    expect(entry?.detail).toBeUndefined();
  });

  it("does not interpret an unrelated activity message as a runtime diagnostic", () => {
    const [entry] = deriveWorkLogEntries([
      makeActivity({ kind: "tool.completed", tone: "tool", summary: "Read file" }),
    ]);

    expect(entry?.detail).toBeUndefined();
  });
});
