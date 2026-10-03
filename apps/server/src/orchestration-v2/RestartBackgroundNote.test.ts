import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  isRestartNoteContinuation,
  pendingRestartCancelledBackgroundWork,
  restartCancelledBackgroundWorkNote,
  restartContinuationNote,
  mergeRestartCancelledBackgroundWork,
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
  status: "completed" as const,
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
      attempts: [{ id: target.activeAttemptId!, runId: target.id }],
    });

  // Codex never lost the work, so it neither receives nor consumes the note.
  assert.deepEqual(pending(onCodex, [root, onCodex]), []);
  assert.deepEqual(pending(backOnClaude, [root, onCodex, backOnClaude]), lost);
  // Once Claude was told, later Claude turns are not.
  const later = run(4, claudeThread);
  assert.deepEqual(pending(later, [root, onCodex, backOnClaude, later]), []);
});

it("delivers a resumed queued run's note even after a higher-ordinal run", () => {
  // Run 3 ran ahead of held run 2; run 2 then resumed, lost background work in
  // a second restart, and its continuation was superseded by a new message.
  const ranFirst = run(3, claudeThread, {
    completedAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
  });
  const resumed = run(2, claudeThread, {
    completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00.000Z"),
    restartCancelledBackgroundWork: lost,
  });
  const next = run(4, claudeThread);
  const runs = [resumed, ranFirst, next];
  assert.deepEqual(
    pendingRestartCancelledBackgroundWork({
      runs,
      providerTurns: [resumed, ranFirst].map(turnFor),
      compactionMessageIds: new Set(),
      run: next,
      attempts: [{ id: next.activeAttemptId!, runId: next.id }],
    }),
    lost,
  );
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
    kind: "command",
    taskId: "t".repeat(400),
    description: "d".repeat(400),
  });
  assert.equal(work.kind, "shell");
  assert.lengthOf(work.label, 160);
  const idOnly = cancelledRosterTaskWork({ kind: "background_task", taskId: "t".repeat(400) });
  assert.lengthOf(idOnly.label, 160);
});

it("keeps separate cancelled tasks that share a kind and label", () => {
  const first = { kind: "shell" as const, label: "sleep 20", id: "item-1" };
  const second = { kind: "shell" as const, label: "sleep 20", id: "item-2" };
  const merged = mergeRestartCancelledBackgroundWork([first], [second, first]);
  assert.deepEqual(merged, [first, second]);
  // Rows recorded before ids existed still collapse by kind + label.
  const legacy = { kind: "shell" as const, label: "sleep 20" };
  assert.lengthOf(mergeRestartCancelledBackgroundWork([legacy], [legacy]), 1);
});

it("does not repeat the note when a steer restarts the run on a new attempt", () => {
  const root = run(1, claudeThread, { restartCancelledBackgroundWork: lost });
  const steered = run(2, claudeThread, {
    activeAttemptId: RunAttemptId.make("attempt:2b"),
  });
  const firstAttempt = RunAttemptId.make("attempt:2a");
  const pending = (runAttemptIds: ReadonlyArray<RunAttemptId>, delivered: boolean) =>
    pendingRestartCancelledBackgroundWork({
      runs: [root, steered],
      providerTurns: [
        turnFor(root),
        ...(delivered
          ? [
              {
                runAttemptId: firstAttempt,
                providerThreadId: claudeThread,
                status: "completed" as const,
              },
            ]
          : []),
      ],
      compactionMessageIds: new Set(),
      run: steered,
      attempts: runAttemptIds.map((id) => ({ id, runId: steered.id })),
    });

  // The first attempt reached the provider with the note; its replacement must not repeat it.
  assert.deepEqual(pending([firstAttempt, RunAttemptId.make("attempt:2b")], true), []);
  // A first attempt that never reached the provider did not deliver it.
  assert.deepEqual(pending([firstAttempt, RunAttemptId.make("attempt:2b")], false), lost);
});

it("counts a prompted mid-turn or chained continuation as delivering the note", () => {
  const cut = run(1, claudeThread, { status: "cancelled", restartCancelledBackgroundWork: lost });
  const cutTurn = { ...turnFor(cut), status: "cancelled" as const };
  const continuation = run(2, claudeThread, { restartContinuationOfRunId: cut.id });
  // A turn cut mid-way that lost work is prompted with the note, not resumed natively.
  assert.isTrue(isRestartNoteContinuation(continuation, [cut, continuation], [cutTurn], []));
  assert.isFalse(
    isRestartNoteContinuation(
      continuation,
      [{ ...cut, restartCancelledBackgroundWork: [] }, continuation],
      [cutTurn],
      [],
    ),
  );
  const later = run(3, claudeThread);
  const pending = (delivered: boolean) =>
    pendingRestartCancelledBackgroundWork({
      runs: [cut, continuation, later],
      providerTurns: [cutTurn, ...(delivered ? [turnFor(continuation)] : [])],
      compactionMessageIds: new Set(),
      run: later,
      attempts: [{ id: later.activeAttemptId!, runId: later.id }],
    });
  assert.deepEqual(pending(true), []);
  // A continuation that never reached the provider delivered nothing.
  assert.deepEqual(pending(false), lost);

  // Its own continuation carries the original note forward.
  const unstarted = { ...continuation, status: "cancelled" as const };
  const chained = run(3, claudeThread, { restartContinuationOfRunId: unstarted.id });
  assert.deepEqual(restartContinuationNote(unstarted, [cut, unstarted], [cutTurn], []), {
    work: lost,
    settled: false,
  });
  assert.isTrue(isRestartNoteContinuation(chained, [cut, unstarted, chained], [cutTurn], []));
  // Claude announces running before accepting the prompt. A second restart
  // can cancel that turn without delivering anything to the provider.
  for (const status of ["running", "cancelled"] as const) {
    const turns = [cutTurn, { ...turnFor(unstarted), status }];
    assert.deepEqual(restartContinuationNote(unstarted, [cut, unstarted], turns, []), {
      work: lost,
      settled: false,
    });
    assert.deepEqual(
      pendingRestartCancelledBackgroundWork({
        runs: [cut, unstarted, later],
        providerTurns: turns,
        compactionMessageIds: new Set(),
        run: later,
        attempts: [{ id: later.activeAttemptId!, runId: later.id }],
      }),
      lost,
    );
  }

  // A steer replaced the attempt after its completed turn delivered the note.
  const steered = { ...unstarted, activeAttemptId: RunAttemptId.make("attempt:replacement") };
  const attempts = [{ id: unstarted.activeAttemptId!, runId: steered.id }];
  const turns = [
    cutTurn,
    turnFor(unstarted),
    { ...turnFor(steered), status: "cancelled" as const },
  ];
  assert.deepEqual(restartContinuationNote(steered, [cut, steered], turns, attempts).work, []);
  assert.isFalse(isRestartNoteContinuation(chained, [cut, steered, chained], turns, attempts));
  assert.deepEqual(
    pendingRestartCancelledBackgroundWork({
      runs: [cut, steered, later],
      providerTurns: turns,
      compactionMessageIds: new Set(),
      run: later,
      attempts,
    }),
    [],
  );
});
