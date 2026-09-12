import {
  WS_METHODS,
  PullRequestRef,
  PullRequestInvalidateInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { EnvironmentRegistry, EnvironmentNotRegisteredError } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  request,
  EnvironmentRpcUnavailableError,
  type EnvironmentRpcInput,
  type EnvironmentUnaryRpcTag,
} from "../rpc/client.ts";

const reads = new Set<string>([
  WS_METHODS.pullRequestsSummary,
  WS_METHODS.pullRequestsStack,
  WS_METHODS.pullRequestsDetail,
  WS_METHODS.pullRequestsActivity,
  WS_METHODS.pullRequestsThreadComments,
  WS_METHODS.pullRequestsDiffFileContents,
  WS_METHODS.pullRequestsReviewerCandidates,
  WS_METHODS.pullRequestsLabelCandidates,
]);
const writes = new Set<string>([
  WS_METHODS.pullRequestsRunAction,
  WS_METHODS.pullRequestsUpdate,
  WS_METHODS.pullRequestsComment,
  WS_METHODS.pullRequestsUpdateComment,
  WS_METHODS.pullRequestsSubmitReview,
  WS_METHODS.pullRequestsReplyToThread,
  WS_METHODS.pullRequestsSetReaction,
  WS_METHODS.pullRequestsSetThreadResolution,
  WS_METHODS.pullRequestsRequestReviewers,
  WS_METHODS.pullRequestsSetLabels,
]);
const isRef = Schema.is(PullRequestRef);
const isInvalidation = Schema.is(PullRequestInvalidateInput);
interface RoutedRead {
  origin: EnvironmentId;
  reference: PullRequestRef;
  targets: Set<EnvironmentId>;
}
const routedReads = new WeakMap<EnvironmentRegistry["Service"], Map<string, RoutedRead>>();
const isUnregistered = Schema.is(EnvironmentNotRegisteredError);
const encodeKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
);

function isLocal(entry: ConnectionCatalogEntry): boolean {
  const url =
    entry.target._tag === "PrimaryConnectionTarget"
      ? entry.target.httpBaseUrl
      : Option.isSome(entry.profile) && entry.profile.value._tag === "BearerConnectionProfile"
        ? entry.profile.value.httpBaseUrl
        : undefined;
  if (url === undefined) return false;
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** A guard rejection is returned before the operation starts. Other write failures are ambiguous. */
function rejectedBeforeDispatch(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error._tag === "EnvironmentRpcUnavailableError" ||
      error._tag === "EnvironmentNotRegisteredError" ||
      (error._tag === "PullRequestOperationError" &&
        "operation" in error &&
        error.operation === "routeIdentity"))
  );
}

/** Credentials stay on their environments. Only a verified host and account cross the wire. */
export function createPullRequestRouter() {
  const routedRequest = Effect.fn("PullRequestRouting.request")(function* <
    T extends EnvironmentUnaryRpcTag,
  >(tag: T, input: EnvironmentRpcInput<T>) {
    if (tag === WS_METHODS.pullRequestsInvalidate && isInvalidation(input)) {
      const result = yield* request(tag, input);
      const origin = yield* EnvironmentSupervisor;
      const registry = yield* EnvironmentRegistry;
      const used = routedReads.get(registry);
      const targets = new Map<EnvironmentId, PullRequestRef>();
      for (const entry of used?.values() ?? []) {
        if (entry.origin !== origin.target.environmentId) continue;
        const ref = input.reference;
        if (
          ref !== undefined &&
          (entry.reference.projectId !== ref.projectId ||
            entry.reference.repository.toLowerCase() !== ref.repository.toLowerCase() ||
            entry.reference.number !== ref.number ||
            (ref.host !== undefined &&
              entry.reference.host?.toLowerCase() !== ref.host.toLowerCase()))
        )
          continue;
        for (const target of entry.targets) targets.set(target, entry.reference);
        if (input.reference !== undefined)
          targets.set(origin.target.environmentId, entry.reference);
      }
      yield* Effect.forEach(
        targets,
        ([target, reference]) =>
          registry
            .run(
              target,
              request(
                WS_METHODS.pullRequestsInvalidate,
                input.reference === undefined ? {} : { reference },
              ),
            )
            .pipe(Effect.orElseSucceed(() => undefined)),
        { concurrency: 4, discard: true },
      );
      return result;
    }
    if ((!reads.has(tag) && !writes.has(tag)) || !isRef(input)) {
      return yield* request(tag, input);
    }
    const ref = input;
    const origin = yield* EnvironmentSupervisor;
    const registry = yield* EnvironmentRegistry;
    const entries = yield* SubscriptionRef.get(registry.entries);
    const used = routedReads.get(registry) ?? new Map<string, RoutedRead>();
    routedReads.set(registry, used);
    const refKey = encodeKey([
      origin.target.environmentId,
      ref.projectId,
      ref.host?.toLowerCase() ?? null,
      ref.repository.toLowerCase(),
      String(ref.number),
    ]);
    const finish = (operation: ReturnType<typeof request<T>>) =>
      operation.pipe(
        Effect.tap(() => {
          if (!writes.has(tag) || used.size === 0) return Effect.void;
          const targets = new Map<EnvironmentId, PullRequestRef[]>([
            [origin.target.environmentId, [ref]],
          ]);
          for (const entry of used.values()) {
            if (
              entry.origin !== origin.target.environmentId ||
              entry.reference.projectId !== ref.projectId ||
              entry.reference.repository.toLowerCase() !== ref.repository.toLowerCase() ||
              entry.reference.number !== ref.number ||
              (ref.host !== undefined &&
                entry.reference.host?.toLowerCase() !== ref.host.toLowerCase())
            )
              continue;
            for (const target of [...entry.targets, origin.target.environmentId]) {
              const refs = targets.get(target) ?? [];
              if (!refs.some((existing) => existing.host === entry.reference.host))
                refs.push(entry.reference);
              targets.set(target, refs);
            }
          }
          return Effect.forEach(
            targets,
            ([target, refs]) =>
              registry
                .run(
                  target,
                  Effect.forEach(
                    [...refs.map((reference) => ({ reference })), {}],
                    (invalidation) =>
                      request(WS_METHODS.pullRequestsInvalidate, invalidation).pipe(
                        // GitHub already accepted the write. A stalled reader on another
                        // environment must not keep its confirmation pending indefinitely.
                        Effect.timeoutOption("1 second"),
                        Effect.orElseSucceed(() => undefined),
                      ),
                    { concurrency: 3, discard: true },
                  ),
                )
                .pipe(Effect.orElseSucceed(() => undefined)),
            { concurrency: 4, discard: true },
          );
        }),
      );
    const alternatives = [];
    for (const [id, entry] of entries) {
      if (id === origin.target.environmentId) continue;
      const connected = yield* registry
        .run(id, EnvironmentSupervisor.pipe(Effect.flatMap((s) => SubscriptionRef.get(s.session))))
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(connected)) alternatives.push({ id, local: isLocal(entry) });
    }
    if (alternatives.length === 0) return yield* finish(request(tag, input));

    const identity = yield* request(WS_METHODS.pullRequestsRouting, ref).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(null),
      ),
    );
    // Old servers and unknown accounts retain the existing path.
    if (identity === null || identity.provider !== "github")
      return yield* finish(request(tag, input));

    const routedInput = {
      ...input,
      host: identity.host,
      expectedAccountId: identity.accountId,
    };
    const local = alternatives.filter((entry) => entry.local);
    const remote = alternatives.filter((entry) => !entry.local);
    const sourceEntry = entries.get(origin.target.environmentId);
    const sourceLocal = sourceEntry !== undefined && isLocal(sourceEntry);
    const candidates = [
      ...(sourceLocal && writes.has(tag) ? [origin.target.environmentId] : []),
      ...local.map((entry) => entry.id),
      ...(!sourceLocal && writes.has(tag) ? [origin.target.environmentId] : []),
      ...remote.map((entry) => entry.id),
      ...(reads.has(tag) ? [origin.target.environmentId] : []),
    ];
    const run = (id: EnvironmentId): ReturnType<typeof request<T>> =>
      registry.run(id, request(tag, routedInput)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const entry = used.get(refKey) ?? {
              origin: origin.target.environmentId,
              reference: { ...ref, host: identity.host },
              targets: new Set<EnvironmentId>(),
            };
            entry.targets.add(id);
            if (used.size >= 256 && !used.has(refKey)) {
              const oldest = used.keys().next().value;
              if (oldest !== undefined) used.delete(oldest);
            }
            used.set(refKey, entry);
          }),
        ),
        Effect.mapError((error) =>
          isUnregistered(error)
            ? new EnvironmentRpcUnavailableError({
                environmentId: id,
                message: "The environment was removed.",
              })
            : error,
        ),
      );
    const visit = (index: number): ReturnType<typeof request<T>> => {
      const id = candidates[index];
      if (id === undefined) return request(tag, routedInput);
      return Effect.gen(function* () {
        if (id !== origin.target.environmentId) {
          // An older server would discard expectedAccountId. Verify it implements the guard first.
          const alternate = yield* registry
            .run(id, request(WS_METHODS.pullRequestsRouting, routedInput))
            .pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(null),
              ),
            );
          if (
            alternate === null ||
            alternate.provider !== "github" ||
            alternate.host.toLowerCase() !== identity.host.toLowerCase() ||
            alternate.accountId !== identity.accountId
          ) {
            return yield* visit(index + 1);
          }
        }
        return yield* run(id).pipe(
          Effect.catch((error) => {
            if (
              (reads.has(tag) || rejectedBeforeDispatch(error)) &&
              index + 1 < candidates.length
            ) {
              return visit(index + 1);
            }
            return Effect.fail(error);
          }),
          Effect.map((result) =>
            typeof result === "object" && result !== null && "projectId" in result
              ? {
                  ...result,
                  projectId: ref.projectId,
                  ...(tag === WS_METHODS.pullRequestsDetail
                    ? { projectTitle: identity.projectTitle, workspaceRoot: identity.workspaceRoot }
                    : {}),
                }
              : result,
          ),
        );
      });
    };
    return yield* finish(visit(0));
  });

  return Effect.fn("PullRequestRouting.readOrWrite")(function* <T extends EnvironmentUnaryRpcTag>(
    tag: T,
    input: EnvironmentRpcInput<T>,
  ) {
    if (!reads.has(tag) || !isRef(input)) return yield* routedRequest(tag, input);
    const registry = yield* EnvironmentRegistry;
    const entries = yield* SubscriptionRef.get(registry.entries);
    if (entries.size < 2) return yield* request(tag, input);
    const strictInput = { ...input, allowStale: false };
    // Cached source reads usually finish before another environment can verify its account.
    // Hedge slow reads only; never race mutations or retry an ambiguous write.
    return yield* Effect.race(
      request(tag, strictInput),
      routedRequest(tag, strictInput).pipe(Effect.delay("75 millis")),
    ).pipe(Effect.catch(() => request(tag, input)));
  });
}
