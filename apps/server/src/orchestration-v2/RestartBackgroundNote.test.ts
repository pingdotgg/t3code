import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";

import {
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  pendingRestartCancelledBackgroundWork,
  restartCancelledBackgroundWorkNote,
} from "./RestartBackgroundNote.ts";

const claudeThread = ProviderThreadId.make("provider-thread:claude");
const codexThread = ProviderThreadId.make("provider-thread:codex");
const lost = [{ kind: "subagent" as const, label: "Background subagent test" }];

function run(
  ordinal: number,
  providerThreadId: ProviderThreadId,
  extra: Partial<OrchestrationV2Run> = {},
): OrchestrationV2Run {
  return {
    id: RunId.make(`run:${ordinal}`),
    ordinal,
    providerThreadId,
    userMessageId: MessageId.make(`message:${ordinal}`),
    activeAttemptId: RunAttemptId.make(`attempt:${ordinal}`),
    status: "completed",
    ...extra,
  } as OrchestrationV2Run;
}

const turnFor = (source: OrchestrationV2Run) => ({
  runAttemptId: source.activeAttemptId,
  providerThreadId: source.providerThreadId!,
});

it("keeps the note for the provider thread that lost the work across a provider switch", () => {
  const root = run(1, claudeThread, { restartCancelledBackgroundWork: lost });
  const onCodex = run(2, codexThread);
  const backOnClaude = run(3, claudeThread);
  const pending = (target: OrchestrationV2Run, runs: ReadonlyArray<OrchestrationV2Run>) =>
    pendingRestartCancelledBackgroundWork({
      runs,
      providerTurns: runs.filter((source) => source.id !== target.id).map(turnFor),
      compactionMessageIds: new Set(),
      run: target,
    });

  // Codex never lost the work, so it neither receives nor consumes the note.
  assert.deepEqual(pending(onCodex, [root, onCodex]), []);
  assert.deepEqual(pending(backOnClaude, [root, onCodex, backOnClaude]), lost);
  // Once Claude was told, later Claude turns are not.
  const later = run(4, claudeThread);
  assert.deepEqual(pending(later, [root, onCodex, backOnClaude, later]), []);
});

it("bounds the note so it cannot crowd out the turn's context", () => {
  const work = Array.from({ length: 25 }, (_, index) => ({
    kind: "shell" as const,
    label: `sleep ${index}`,
  }));
  const note = restartCancelledBackgroundWorkNote(work);
  assert.lengthOf(note.split("\n"), 12);
  assert.isTrue(note.endsWith("- and 15 more"));
  const command = cancelledTurnItemWork({
    type: "command_execution",
    input: "x".repeat(10_000),
    title: null,
  } as never);
  assert.isAtMost(command?.label.length ?? 0, 160);
});

it("bounds roster task labels including a long task id", () => {
  const work = cancelledRosterTaskWork({
    taskId: "t".repeat(400),
    taskType: "local_bash",
    description: "d".repeat(400),
  });
  assert.equal(work.kind, "shell");
  assert.lengthOf(work.label, 160);
  const idOnly = cancelledRosterTaskWork({ taskId: "t".repeat(400) });
  assert.lengthOf(idOnly.label, 160);
});
