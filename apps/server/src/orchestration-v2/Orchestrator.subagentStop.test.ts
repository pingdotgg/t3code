import { ProviderSessionId, ProviderThreadId, RunId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { providerSessionIdForSubagentStop } from "./Orchestrator.ts";

const runId = RunId.make("run-subagent-stop");
const runThreadId = ProviderThreadId.make("provider-thread-run");
const activeThreadId = ProviderThreadId.make("provider-thread-active");
const staleThreadId = ProviderThreadId.make("provider-thread-stale");
const runSessionId = ProviderSessionId.make("provider-session-run");
const activeSessionId = ProviderSessionId.make("provider-session-active");
const staleSessionId = ProviderSessionId.make("provider-session-stale");

it("prefers the run session when stopping a subagent", () => {
  assert.equal(
    providerSessionIdForSubagentStop({
      runId,
      activeProviderThreadId: activeThreadId,
      runs: [{ id: runId, providerThreadId: runThreadId }],
      providerThreads: [
        { id: activeThreadId, providerSessionId: activeSessionId },
        { id: runThreadId, providerSessionId: runSessionId },
      ],
    }),
    runSessionId,
  );
});

it("falls back only to the explicitly active provider thread", () => {
  assert.equal(
    providerSessionIdForSubagentStop({
      runId,
      activeProviderThreadId: activeThreadId,
      runs: [{ id: runId, providerThreadId: runThreadId }],
      providerThreads: [
        { id: staleThreadId, providerSessionId: staleSessionId },
        { id: runThreadId, providerSessionId: null },
        { id: activeThreadId, providerSessionId: activeSessionId },
      ],
    }),
    activeSessionId,
  );
});

it("returns null when neither the run nor active thread has a session", () => {
  assert.isNull(
    providerSessionIdForSubagentStop({
      runId,
      activeProviderThreadId: null,
      runs: [{ id: runId, providerThreadId: runThreadId }],
      providerThreads: [
        { id: staleThreadId, providerSessionId: staleSessionId },
        { id: runThreadId, providerSessionId: null },
      ],
    }),
  );
});
