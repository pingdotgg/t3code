import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, type PullRequestActionOutcome } from "@t3tools/contracts";

import type * as GitCafeCli from "../sourceControl/GitCafeCli.ts";
import { PullRequestProviderError, type PullRequestProviderApi } from "./PullRequestProvider.ts";
import { gitCafeWriteApi } from "./gitCafeWriteApi.ts";

const Oid = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
const Pull = Schema.Struct({
  number: PositiveInt,
  state: Schema.Literals(["open", "closed", "merged"]),
  draft: Schema.Boolean,
  version: NonNegativeInt,
  targetBranch: Schema.String,
  headOid: Schema.NullOr(Oid),
  observedBaseOid: Schema.NullOr(Oid),
  mergeSourceOid: Schema.optional(Schema.NullOr(Oid)),
  mergeTargetOidBefore: Schema.optional(Schema.NullOr(Oid)),
  mergeRoute: Schema.optional(Schema.Literals(["native", "provider", "unsupported"])),
});
const StackMember = Schema.Struct({
  state: Schema.Literals(["open", "closed", "merged"]),
});
const Stack = Schema.Struct({
  number: PositiveInt,
  revision: PositiveInt,
  members: Schema.Array(StackMember),
});
const StackEnvelope = Schema.Struct({ stack: Schema.NullOr(Stack) });
const LifecycleResponse = Schema.Struct({ version: NonNegativeInt });
const Commit = Schema.Struct({ oid: Oid });
const MergeOutcome = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["accepted", "completed", "failed"]),
  resultOid: Schema.optional(Oid),
  reason: Schema.optional(Schema.String),
  waiting: Schema.optional(Schema.Struct({ reason: Schema.String })),
  failure: Schema.optional(Schema.Struct({ code: Schema.String })),
});
const StackOperationError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
const LandStep = Schema.Struct({
  mergeOperationId: Schema.NullOr(Schema.String),
  mergeState: Schema.NullOr(
    Schema.Literals(["preparing", "prepared", "ref_applied", "completed", "failed"]),
  ),
});
const LandOutcome = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals([
    "pending",
    "running",
    "awaiting_credential",
    "reconciliation_required",
    "completed",
    "stopped",
    "failed",
  ]),
  landedCount: NonNegativeInt,
  stepCount: PositiveInt,
  stopReason: Schema.NullOr(StackOperationError),
  error: Schema.NullOr(StackOperationError),
  steps: Schema.Array(LandStep),
  provider: Schema.optional(Schema.Literal("github")),
});
const RestackOutcome = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals([
    "pending",
    "running",
    "awaiting_credential",
    "paused_conflict",
    "paused_policy",
    "cancel_requested",
    "cancelled",
    "reconciliation_required",
    "completed",
    "failed",
  ]),
  stepCount: PositiveInt,
  completedStepCount: NonNegativeInt,
  pauseReason: Schema.NullOr(StackOperationError),
});

type GitCafeActionInput = Parameters<PullRequestProviderApi["runAction"]>[0];
const fail = (operation: string, detail: string) =>
  new PullRequestProviderError({
    provider: "gitcafe",
    operation,
    reason: "failed",
    detail,
    notDispatched: true,
  });
const markNotDispatched = (error: PullRequestProviderError) =>
  error.notDispatched === true
    ? error
    : new PullRequestProviderError({
        provider: error.provider,
        operation: error.operation,
        reason: error.reason,
        detail: error.detail,
        notDispatched: true,
        ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
        cause: error,
      });
const requestIdError = (requestId: string | undefined) =>
  requestId === undefined
    ? "A request ID is required to submit durable GitCafe work."
    : requestId.length > 96 || !/^[!-~]+$/u.test(requestId)
      ? "The request ID must contain 1 to 96 printable ASCII characters."
      : undefined;

const STACK_LAND_POLL_INTERVAL = "500 millis";

/** GitCafe lifecycle and exact single-pull-request merge writes. */
export function makeGitCafeActionWrites(cli: GitCafeCli.GitCafeCli["Service"]) {
  const request = gitCafeWriteApi(cli);
  const readPull = (input: GitCafeActionInput, number = input.number) =>
    request(input, `/pulls/${number}`, Pull, { operation: "readActionFence" }).pipe(
      Effect.mapError(markNotDispatched),
    );
  const readStackForPull = (input: GitCafeActionInput) =>
    request(input, `/pulls/${input.number}/stack`, StackEnvelope, {
      operation: "readStackFence",
    }).pipe(Effect.mapError(markNotDispatched));
  const normalizeMerge = (outcome: typeof MergeOutcome.Type): PullRequestActionOutcome => ({
    operation: { kind: "merge", id: outcome.id },
    state: outcome.state === "accepted" ? "pending" : outcome.state,
    detail:
      outcome.state === "accepted"
        ? `Merge accepted but not complete${outcome.waiting ? `: ${outcome.waiting.reason}` : ""}. Inspect this operation again.`
        : outcome.state === "completed"
          ? `Merge completed${outcome.resultOid ? ` at ${outcome.resultOid}` : ""}.`
          : `Merge failed: ${outcome.reason ?? outcome.failure?.code ?? "unknown failure"}.`,
  });
  const normalizeStack = (
    kind: "stack-land" | "stack-restack",
    outcome: typeof LandOutcome.Type | typeof RestackOutcome.Type,
  ): PullRequestActionOutcome => {
    const failed =
      outcome.state === "failed" || outcome.state === "stopped" || outcome.state === "cancelled";
    const progress =
      "landedCount" in outcome
        ? `${outcome.landedCount}/${outcome.stepCount} pull requests landed`
        : `${outcome.completedStepCount}/${outcome.stepCount} pull requests restacked`;
    const problem =
      "error" in outcome ? (outcome.error ?? outcome.stopReason) : outcome.pauseReason;
    return {
      operation: { kind, id: outcome.id },
      state: outcome.state === "completed" ? "completed" : failed ? "failed" : "pending",
      detail: `${kind === "stack-land" ? "Stack landing" : "Stack restack"} ${outcome.state}: ${progress}${problem ? `; ${problem.message}` : ""}.`,
    };
  };
  const continueStackLand = Effect.fn("GitCafeActionWrites.continueStackLand")(function* (
    input: GitCafeActionInput,
    stackNumber: number,
    admitted: typeof LandOutcome.Type,
  ) {
    const id = admitted.id;
    let current = admitted;
    let resumedAtLandedCount: number | undefined;
    while (true) {
      if (["completed", "stopped", "failed", "reconciliation_required"].includes(current.state))
        return current;

      const next = current.steps[current.landedCount];
      if (
        current.state === "awaiting_credential" &&
        current.provider === undefined &&
        next !== undefined &&
        next.mergeOperationId === null &&
        resumedAtLandedCount !== current.landedCount
      ) {
        const fresh = yield* request(input, `/pulls/stacks/${stackNumber}`, Stack, {
          operation: "readStackFence",
        });
        resumedAtLandedCount = current.landedCount;
        current = yield* request(
          input,
          `/pulls/stacks/${stackNumber}/land-through/${encodeURIComponent(id)}/resume`,
          LandOutcome,
          {
            operation: "resumeStackLand",
            method: "POST",
            body: { expectedRevision: fresh.revision },
          },
        );
        if (current.id !== id)
          return yield* Effect.fail(
            fail(
              "resumeStackLand",
              `GitCafe returned a different stack operation; expected ${id}.`,
            ),
          );
        continue;
      }

      yield* Effect.sleep(STACK_LAND_POLL_INTERVAL);
      current = yield* request(
        input,
        `/pulls/stacks/${stackNumber}/land-through/${encodeURIComponent(id)}`,
        LandOutcome,
        { operation: "inspectStackLand" },
      );
      if (current.id !== id)
        return yield* Effect.fail(
          fail("inspectStackLand", `GitCafe returned a different stack operation; expected ${id}.`),
        );
    }
  });
  const runAction = Effect.fn("GitCafeActionWrites.runAction")(function* (
    input: GitCafeActionInput,
  ) {
    if (input.operation !== undefined) {
      const { kind, id } = input.operation;
      if (kind === "merge") {
        if (input.action !== "merge")
          return yield* Effect.fail(
            fail("inspectOperation", "The operation kind does not match the requested action."),
          );
        const value = yield* request(
          input,
          `/pulls/${input.number}/merge/${encodeURIComponent(id)}`,
          MergeOutcome,
          { operation: "inspectMerge" },
        );
        if (value.id !== id)
          return yield* Effect.fail(
            fail("inspectMerge", "GitCafe returned a different merge operation."),
          );
        return normalizeMerge(value);
      }
      if (input.stackNumber === undefined)
        return yield* Effect.fail(
          fail("inspectOperation", "A stack number is required to inspect stack work."),
        );
      const latest = id === "latest";
      const path =
        kind === "stack-land"
          ? `/pulls/stacks/${input.stackNumber}/land-through/${latest ? "latest" : encodeURIComponent(id)}`
          : `/pulls/stacks/${input.stackNumber}/restacks/${latest ? "latest" : encodeURIComponent(id)}`;
      const schema = kind === "stack-land" ? LandOutcome : RestackOutcome;
      const value = yield* request(input, path, Schema.NullOr(schema), {
        operation: kind === "stack-land" ? "inspectStackLand" : "inspectStackRestack",
      });
      if (value === null)
        return yield* Effect.fail(
          fail("inspectOperation", "GitCafe has no latest operation for this stack."),
        );
      if (!latest && value.id !== id)
        return yield* Effect.fail(
          fail("inspectOperation", "GitCafe returned a different stack operation."),
        );
      return normalizeStack(kind, value);
    }

    if (input.stackNumber !== undefined) {
      const operation =
        input.action === "merge"
          ? "stack-land"
          : input.action === "update-branch"
            ? "stack-restack"
            : undefined;
      if (operation === undefined)
        return yield* Effect.fail(
          fail("stackAction", `GitCafe does not support ${input.action} for a stack.`),
        );
      const invalidRequestId = requestIdError(input.requestId);
      if (invalidRequestId !== undefined)
        return yield* Effect.fail(fail(operation, invalidRequestId));
      if (input.expectedStackRevision === undefined)
        return yield* Effect.fail(fail(operation, "The expected stack revision is required."));
      const land = operation === "stack-land";
      const value = yield* request(
        input,
        land
          ? `/pulls/stacks/${input.stackNumber}/land-through`
          : `/pulls/stacks/${input.stackNumber}/restack`,
        land ? LandOutcome : RestackOutcome,
        {
          operation: land ? "landStackThrough" : "restackStack",
          method: "POST",
          body: land
            ? {
                expectedRevision: input.expectedStackRevision,
                requestId: input.requestId,
                throughPullRequestNumber: input.number,
                strategy: input.mergeMethod ?? "merge",
              }
            : {
                expectedRevision: input.expectedStackRevision,
                requestId: input.requestId,
                fromPullRequestNumber: input.number,
              },
        },
      );
      if (!land) return normalizeStack(operation, value);
      // Admission already succeeded. Keep its identity even if a subsequent read or
      // credential handoff fails; the original merge must never become safe to resubmit.
      const pending = (detail: string): PullRequestActionOutcome => ({
        operation: { kind: "stack-land", id: value.id },
        state: "pending",
        detail,
      });
      return yield* continueStackLand(
        input,
        input.stackNumber,
        value as typeof LandOutcome.Type,
      ).pipe(
        Effect.map((outcome) => normalizeStack("stack-land", outcome)),
        Effect.timeoutOrElse({
          duration: "20 seconds",
          orElse: () =>
            Effect.succeed(pending("Stack landing is not yet confirmed. Check its status.")),
        }),
        Effect.catch((error) =>
          Effect.succeed(pending(`Stack landing could not be confirmed: ${error.detail}`)),
        ),
      );
    }

    if (
      ["enable-auto-merge", "disable-auto-merge", "revert", "approve-workflows"].includes(
        input.action,
      )
    )
      return yield* Effect.fail(
        fail(input.action, `GitCafe does not support ${input.action} from T3 Code.`),
      );

    if (["ready", "draft", "close", "reopen"].includes(input.action)) {
      const pull = yield* readPull(input);
      if (input.action === "close") {
        const membership = yield* readStackForPull(input);
        if (membership.stack !== null)
          return yield* Effect.fail(
            fail(
              "close",
              `Pull request #${input.number} is in active stack #${membership.stack.number}; unstack or land it first.`,
            ),
          );
      }
      yield* request(input, `/pulls/${input.number}/${input.action}`, LifecycleResponse, {
        operation: input.action,
        method: "POST",
        body: { expectedVersion: pull.version },
      });
      return undefined;
    }

    if (input.action === "update-branch") {
      return yield* Effect.fail(
        fail(
          "update-branch",
          "GitCafe branch updates are disabled because its only update route mutates a stack.",
        ),
      );
    }

    const pull = yield* readPull(input);
    if (pull.mergeRoute === "unsupported")
      return yield* Effect.fail(
        fail("merge", "This GitCafe pull request has no supported merge route."),
      );
    const invalidRequestId = requestIdError(input.requestId);
    if (invalidRequestId !== undefined) return yield* Effect.fail(fail("merge", invalidRequestId));
    const headOid = pull.headOid;
    if (headOid === null)
      return yield* Effect.fail(
        fail(
          "merge",
          "GitCafe did not provide an exact current head object ID. Refresh before merging.",
        ),
      );
    const baseOid =
      pull.mergeRoute === "provider"
        ? pull.observedBaseOid
        : (yield* request(
            input,
            `/commit?ref=${encodeURIComponent(`refs/heads/${pull.targetBranch}`)}`,
            Commit,
            { operation: "readMergeBase" },
          ).pipe(Effect.mapError(markNotDispatched))).oid;
    if (baseOid === null)
      return yield* Effect.fail(
        fail(
          "merge",
          "GitCafe did not provide exact head and base object IDs. Refresh before merging.",
        ),
      );
    return normalizeMerge(
      yield* request(input, `/pulls/${input.number}/merge`, MergeOutcome, {
        operation: pull.mergeRoute === "provider" ? "providerMerge" : "nativeMerge",
        method: "POST",
        body: {
          requestId: input.requestId,
          expectedVersion: pull.version,
          headOid,
          baseOid,
          strategy: input.mergeMethod ?? "merge",
        },
      }),
    );
  });

  return { runAction } satisfies Pick<PullRequestProviderApi, "runAction">;
}
