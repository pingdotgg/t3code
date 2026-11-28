import { describe, expect, it } from "vite-plus/test";
import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2ThreadProjection,
  RunAttemptId,
  RunId,
} from "@t3tools/contracts";

import { unsentManualContinuationSource } from "./orchestrationV2ManualContinuation.ts";

// The source only reads id/manualContinuationOfRunId on runs, runId+attemptOrdinal+reason+id
// on attempts, and runAttemptId on turns, so the fixtures carry just those fields.
const run = (id: string, manualContinuationOfRunId?: string) =>
  ({ id, manualContinuationOfRunId }) as unknown as OrchestrationV2Run;

const attempt = (id: string, runId: string, ordinal: number, reason = "initial") =>
  ({ id, runId, attemptOrdinal: ordinal, reason }) as unknown as OrchestrationV2RunAttempt;

const turn = (runAttemptId: string | null) =>
  ({ runAttemptId: runAttemptId as RunAttemptId | null }) as OrchestrationV2ProviderTurn;

const projection = (
  runs: OrchestrationV2Run[],
  attempts: OrchestrationV2RunAttempt[],
  providerTurns: OrchestrationV2ProviderTurn[],
) =>
  ({ runs, attempts, providerTurns }) as Pick<
    OrchestrationV2ThreadProjection,
    "runs" | "attempts" | "providerTurns"
  >;

describe("unsentManualContinuationSource", () => {
  it("returns undefined when the source run no longer exists", () => {
    expect(
      unsentManualContinuationSource(run("r2", "ghost" as RunId), projection([run("r2")], [], [])),
    ).toBeUndefined();
  });

  it("returns the source run when it never had an accepted attempt", () => {
    const source = run("src");
    expect(
      unsentManualContinuationSource(run("r2", "src" as RunId), projection([source], [], [])),
    ).toBe(source);
  });

  it("returns undefined once the source attempt was accepted", () => {
    const a1 = attempt("a1", "src", 1);
    expect(
      unsentManualContinuationSource(
        run("r2", "src" as RunId),
        projection([run("src")], [a1], [turn("a1")]),
      ),
    ).toBeUndefined();
  });

  it("returns the source when a steering restart ran after the accepted attempt", () => {
    const source = run("src");
    const a1 = attempt("a1", "src", 1);
    const a2 = attempt("a2", "src", 2, "steering_restart");
    expect(
      unsentManualContinuationSource(
        run("r2", "src" as RunId),
        projection([source], [a1, a2], [turn("a1")]),
      ),
    ).toBe(source);
  });

  it("ignores a steering restart that predates the accepted attempt", () => {
    const a1 = attempt("a1", "src", 1, "steering_restart");
    const a2 = attempt("a2", "src", 2);
    expect(
      unsentManualContinuationSource(
        run("r2", "src" as RunId),
        projection([run("src")], [a1, a2], [turn("a2")]),
      ),
    ).toBeUndefined();
  });

  it("walks a chain of manual continuations until a source that never delivered", () => {
    const root = run("root");
    const mid = run("mid", "root" as RunId);
    expect(
      unsentManualContinuationSource(run("r3", "mid" as RunId), projection([root, mid], [], [])),
    ).toBe(root);
  });

  it("stops the chain at a source whose attempt was accepted", () => {
    const root = run("root");
    const mid = run("mid", "root" as RunId);
    const midAccepted = attempt("a-mid", "mid", 1);
    const rootRestart = attempt("a-root", "root", 1, "steering_restart");
    // mid's accepted attempt already delivered the forwarded message, so
    // root's older steering restart is not still pending.
    expect(
      unsentManualContinuationSource(
        run("r3", "mid" as RunId),
        projection([root, mid], [midAccepted, rootRestart], [turn("a-mid")]),
      ),
    ).toBeUndefined();
  });

  it("stops on a cyclic continuation chain instead of looping", () => {
    const a = run("a", "b" as RunId);
    const b = run("b", "a" as RunId);
    expect(
      unsentManualContinuationSource(run("c", "a" as RunId), projection([a, b], [], [])),
    ).toBeUndefined();
  });

  it("treats a turn with promptDropped as unsent", () => {
    const source = run("src");
    const a1 = attempt("a1", "src", 1);
    const dropped = { ...turn("a1"), promptDropped: true as const };
    expect(
      unsentManualContinuationSource(
        run("r2", "src" as RunId),
        projection([source], [a1], [dropped]),
      ),
    ).toBe(source);
  });
});
