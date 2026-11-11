import {
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type ProofJudge,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

export type ProofJudgeCommand = Extract<
  OrchestrationV2ServerCommand,
  {
    readonly type:
      | "proof-judge.request"
      | "proof-judge.accept"
      | "proof-judge.reject"
      | "proof-judge.reopen";
  }
>;

const judgesOf = (thread: OrchestrationV2AppThread): ReadonlyArray<ProofJudge> =>
  thread.proofJudges ?? [];

const withJudges = (
  thread: OrchestrationV2AppThread,
  judges: ReadonlyArray<ProofJudge>,
  now: DateTime.Utc,
) =>
  Result.succeed({
    ...thread,
    proofJudges: [...judges],
    updatedAt: now,
  });

const findJudge = (judges: ReadonlyArray<ProofJudge>, judgeId: ProofJudge["id"]) => {
  const index = judges.findIndex((judge) => judge.id === judgeId);
  if (index < 0) return Result.fail(`Proof judge ${judgeId} was not found.`);
  return Result.succeed({ judge: judges[index]!, index });
};

const replaceAt = (
  judges: ReadonlyArray<ProofJudge>,
  index: number,
  judge: ProofJudge,
): ReadonlyArray<ProofJudge> => judges.map((candidate, i) => (i === index ? judge : candidate));

const decidedBy = (actorThreadId: ThreadId | undefined): ProofJudge["decidedBy"] =>
  actorThreadId === undefined ? "user" : actorThreadId;

/**
 * Applies a proof-judge command. Settling stays blocked while any judge is requested or rejected.
 */
export function decideProofJudgeCommand(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly command: ProofJudgeCommand;
  readonly now: DateTime.Utc;
}): Result.Result<OrchestrationV2AppThread, string> {
  const { thread, command, now } = input;
  if (thread.deletedAt !== null) return Result.fail(`Thread ${thread.id} is deleted.`);
  if (thread.archivedAt !== null) {
    return Result.fail("Archived threads cannot change proof judges.");
  }

  const judges = judgesOf(thread);
  const nowIso = DateTime.formatIso(now);

  switch (command.type) {
    case "proof-judge.request": {
      if (judges.some((judge) => judge.id === command.judgeId)) {
        return Result.fail(`Proof judge ${command.judgeId} already exists.`);
      }
      const judge: ProofJudge = {
        id: command.judgeId,
        name: command.name,
        criteria: command.criteria,
        status: "requested",
        requestedByThreadId: command.requestedByThreadId,
        requestedAt: nowIso,
        decidedBy: null,
        decidedAt: null,
        note: null,
        reopenedAt: null,
      };
      return withJudges(thread, [...judges, judge], now);
    }
    case "proof-judge.accept": {
      const found = findJudge(judges, command.judgeId);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { judge, index } = found.success;
      if (judge.status !== "requested") {
        return Result.fail(
          `Proof judge ${command.judgeId} must be requested before accept (${judge.status}).`,
        );
      }
      return withJudges(
        thread,
        replaceAt(judges, index, {
          ...judge,
          status: "accepted",
          decidedBy: decidedBy(command.actorThreadId),
          decidedAt: nowIso,
          note: command.note ?? judge.note,
        }),
        now,
      );
    }
    case "proof-judge.reject": {
      const found = findJudge(judges, command.judgeId);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { judge, index } = found.success;
      if (judge.status !== "requested") {
        return Result.fail(
          `Proof judge ${command.judgeId} must be requested before reject (${judge.status}).`,
        );
      }
      return withJudges(
        thread,
        replaceAt(judges, index, {
          ...judge,
          status: "rejected",
          decidedBy: decidedBy(command.actorThreadId),
          decidedAt: nowIso,
          note: command.note ?? judge.note,
        }),
        now,
      );
    }
    case "proof-judge.reopen": {
      const found = findJudge(judges, command.judgeId);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { judge, index } = found.success;
      if (judge.status !== "accepted" && judge.status !== "rejected") {
        return Result.fail(
          `Proof judge ${command.judgeId} must be accepted or rejected before reopen (${judge.status}).`,
        );
      }
      return withJudges(
        thread,
        replaceAt(judges, index, {
          ...judge,
          status: "requested",
          decidedBy: null,
          decidedAt: null,
          note: null,
          reopenedAt: nowIso,
        }),
        now,
      );
    }
  }
}
