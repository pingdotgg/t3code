import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

/**
 * One operation of a radicle-ci-broker job record, as `rad cob log --format json` prints it,
 * newest first. `rad cob show` cannot read jobs: it needs a `rad-cob-job` helper Radicle does not
 * ship.
 */
const isRequest = Schema.is(Schema.Struct({ Request: Schema.Struct({ oid: Schema.String }) }));
const isRun = Schema.is(
  Schema.Struct({ Run: Schema.Struct({ log: Schema.String, uuid: Schema.String }) }),
);
const isFinished = Schema.is(
  Schema.Struct({ Finished: Schema.Struct({ reason: Schema.String, uuid: Schema.String }) }),
);
const JobOp = Schema.Struct({
  author: Schema.String,
  timestamp: Schema.Number,
  // Kinds a later broker may add are skipped rather than failing the whole job.
  actions: Schema.Array(Schema.Unknown),
});
const decodeJobOp = decodeJsonResult(JobOp);

export interface RadicleJobRun {
  readonly uuid: string;
  readonly log: string;
  readonly startedAt: number;
  /** `Succeeded` or `Failed`; null while the run has not finished. */
  readonly result: string | null;
}

export interface RadicleJob {
  readonly id: string;
  /** The commit the job ran for. */
  readonly commit: string;
  /** The CI node that wrote the job, a node ID. */
  readonly author: string;
  /** Oldest first; a rerun adds one. */
  readonly runs: ReadonlyArray<RadicleJobRun>;
}

/** Null when no line decodes or the job names no commit. */
export function parseJobLog(id: string, stdout: string): RadicleJob | null {
  const ops = stdout
    .split("\n")
    .flatMap((line) => {
      if (line.trim().length === 0) return [];
      const op = decodeJobOp(line);
      return Result.isSuccess(op) ? [op.success] : [];
    })
    // Newest first, in history order; timestamps tie within a second, so they cannot order it.
    .toReversed();
  let commit: string | null = null;
  const runs = new Map<string, { log: string; startedAt: number; result: string | null }>();
  for (const op of ops) {
    for (const action of op.actions) {
      if (isRequest(action)) commit ??= action.Request.oid;
      if (isRun(action)) {
        const { uuid, log } = action.Run;
        runs.set(uuid, { log, startedAt: op.timestamp, result: runs.get(uuid)?.result ?? null });
      }
      if (isFinished(action)) {
        const { uuid, reason } = action.Finished;
        const run = runs.get(uuid);
        if (run) runs.set(uuid, { ...run, result: reason });
      }
    }
  }
  const author = ops[0]?.author;
  return commit === null || author === undefined
    ? null
    : {
        id,
        commit,
        author,
        runs: [...runs].map(([uuid, run]) => ({ uuid, ...run })),
      };
}
