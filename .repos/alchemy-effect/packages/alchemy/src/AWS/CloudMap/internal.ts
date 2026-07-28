import * as sd from "@distilled.cloud/aws/servicediscovery";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { diffTags } from "../../Tags.ts";

/**
 * Raised when an asynchronous Cloud Map operation (namespace create/delete,
 * instance register/deregister, service update) terminates with `FAIL` or
 * fails to reach a terminal status within the polling budget.
 */
export class CloudMapOperationFailed extends Data.TaggedError(
  "CloudMapOperationFailed",
)<{
  readonly operationId: string;
  readonly status: string | undefined;
  readonly errorCode: string | undefined;
  readonly errorMessage: string | undefined;
}> {}

/**
 * Repeat a `getOperation` poll until the operation reaches a terminal status
 * (`SUCCESS` | `FAIL`), spaced 2s and bounded at 60 repetitions (~2 minutes —
 * namespace operations typically take 30-60s).
 *
 * Expressed as an explicitly-typed helper: inlining `Effect.repeat` in
 * lifecycle code leaves its conditional return type unresolved in the
 * provider's declaration emit, which widens the `AWS.providers()` layer type
 * for every downstream consumer.
 */
const untilTerminalStatus = <E, R>(
  self: Effect.Effect<sd.GetOperationResponse, E, R>,
): Effect.Effect<sd.Operation | undefined, E, R> =>
  Effect.repeat(
    Effect.map(self, (response) => response.Operation),
    {
      schedule: Schedule.spaced("2 seconds"),
      until: (operation) =>
        operation?.Status === "SUCCESS" || operation?.Status === "FAIL",
      times: 60,
    },
  );

/**
 * Await a Cloud Map async operation: poll `getOperation` (bounded) until it
 * reaches a terminal status and fail with `CloudMapOperationFailed` unless
 * that status is `SUCCESS`. Returns the terminal `Operation` (whose
 * `Targets` map carries the created NAMESPACE/SERVICE/INSTANCE ids).
 */
export const awaitOperation = Effect.fn("AWS.CloudMap.awaitOperation")(
  function* (operationId: string) {
    const operation = yield* untilTerminalStatus(
      sd.getOperation({ OperationId: operationId }),
    );
    if (operation?.Status !== "SUCCESS") {
      return yield* Effect.fail(
        new CloudMapOperationFailed({
          operationId,
          status: operation?.Status,
          errorCode: operation?.ErrorCode,
          errorMessage: operation?.ErrorMessage,
        }),
      );
    }
    return operation;
  },
);

/**
 * Bounded retry through transient `ResourceInUse` dependency violations —
 * e.g. deleting a namespace while its last service deletion is still
 * propagating, or deleting a service while an instance deregistration is in
 * flight. Explicitly typed for the same declaration-emit reason as above.
 */
export const retryWhileResourceInUse = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ResourceInUse",
    schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(20)]),
  });

/**
 * Deregister every instance still registered on a service and await the
 * async deregistration operations. Instances registered at runtime (via the
 * `RegisterInstance` binding) are data-plane ephemera owned by the service —
 * they would otherwise block `DeleteService` with `ResourceInUse` forever.
 * Deregistrations already in flight surface as `DuplicateRequest` and are
 * tolerated; `DeleteService`'s own `ResourceInUse` retry rides out the
 * remaining visibility window.
 */
export const deregisterAllInstances = Effect.fn(
  "AWS.CloudMap.deregisterAllInstances",
)(function* (serviceId: string) {
  const operationIds: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = yield* sd.listInstances({
      ServiceId: serviceId,
      NextToken: nextToken,
    });
    for (const instance of page.Instances ?? []) {
      if (instance.Id === undefined) {
        continue;
      }
      const response = yield* sd
        .deregisterInstance({ ServiceId: serviceId, InstanceId: instance.Id })
        .pipe(
          // already gone / a deregistration already in flight — both mean
          // the instance is on its way out
          Effect.catchTag(["InstanceNotFound", "DuplicateRequest"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (response?.OperationId !== undefined) {
        operationIds.push(response.OperationId);
      }
    }
    nextToken = page.NextToken;
  } while (nextToken !== undefined);
  for (const operationId of operationIds) {
    yield* awaitOperation(operationId);
  }
});

export type NamespaceKind = "DNS_PRIVATE" | "DNS_PUBLIC" | "HTTP";

/** Find a namespace of the given type by exact name via the list API. */
export const findNamespaceByName = Effect.fn(
  "AWS.CloudMap.findNamespaceByName",
)(function* (type: NamespaceKind, name: string) {
  const response = yield* sd.listNamespaces({
    Filters: [
      { Name: "TYPE", Values: [type], Condition: "EQ" },
      { Name: "NAME", Values: [name], Condition: "EQ" },
    ],
  });
  return response.Namespaces?.[0];
});

/**
 * Observe a namespace: by cached id when we have one (tolerating out-of-band
 * deletion), falling back to an exact-name list lookup.
 */
export const observeNamespace = Effect.fn("AWS.CloudMap.observeNamespace")(
  function* (
    type: NamespaceKind,
    name: string,
    namespaceId: string | undefined,
  ) {
    if (namespaceId !== undefined) {
      const byId = yield* sd.getNamespace({ Id: namespaceId }).pipe(
        Effect.map((r) => r.Namespace),
        Effect.catchTag("NamespaceNotFound", () => Effect.succeed(undefined)),
      );
      if (byId !== undefined) {
        return byId;
      }
    }
    const summary = yield* findNamespaceByName(type, name);
    if (summary?.Id === undefined) {
      return undefined;
    }
    // hydrate the summary into the full Namespace shape (keeps one return
    // type; also tolerates a delete race between list and get)
    return yield* sd.getNamespace({ Id: summary.Id }).pipe(
      Effect.map((r) => r.Namespace),
      Effect.catchTag("NamespaceNotFound", () => Effect.succeed(undefined)),
    );
  },
);

/**
 * Ensure a namespace exists: submit `create`, await its async operation, and
 * observe the created namespace **by the operation's target id** — the
 * `listNamespaces` name lookup is eventually consistent and can miss a
 * namespace created milliseconds earlier.
 *
 * A same-name predecessor still mid-deletion (e.g. the old physical resource
 * of a replacement, or an out-of-band cleaner) surfaces the create as
 * `NamespaceAlreadyExists` while remaining invisible to observation; the
 * whole create+observe sequence retries (bounded, ~40s) until the deletion
 * completes and the create goes through. A `DuplicateRequest` means an
 * identical create is already in flight — its operation is awaited instead.
 */
const retryWhileNamespaceNotVisible = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "NamespaceNotFound",
    schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(8)]),
  });

/**
 * The (identical) typed error union of the three namespace create operations.
 * Kept concrete — a generic error parameter here would flow into
 * `Effect.catchTag`, leaving an un-narrowable `{ _tag: unknown }` residue in
 * the handler under TypeScript 7.
 */
type CreateNamespaceError =
  | sd.CreateHttpNamespaceError
  | sd.CreatePrivateDnsNamespaceError
  | sd.CreatePublicDnsNamespaceError;

export const ensureNamespace = <R>(
  type: NamespaceKind,
  name: string,
  create: Effect.Effect<
    { OperationId?: string | undefined },
    CreateNamespaceError,
    R
  >,
) =>
  retryWhileNamespaceNotVisible(
    Effect.gen(function* () {
      const created: {
        OperationId?: string | undefined;
        NamespaceId?: string | undefined;
      } = yield* create.pipe(
        Effect.catchTag(["NamespaceAlreadyExists", "DuplicateRequest"], (e) =>
          e._tag === "NamespaceAlreadyExists"
            ? // the name is taken — by an ACTIVE namespace (observed below)
              // or by one still deleting (observation misses it and the
              // bounded outer retry re-submits the create)
              Effect.succeed({
                OperationId: undefined,
                NamespaceId: e.NamespaceId,
              })
            : // an identical create is already in flight — await THAT one
              Effect.succeed({
                OperationId: e.DuplicateOperationId,
                NamespaceId: undefined,
              }),
        ),
      );
      let namespaceId = created.NamespaceId;
      if (created.OperationId !== undefined) {
        const operation = yield* awaitOperation(created.OperationId);
        namespaceId = operation?.Targets?.NAMESPACE ?? namespaceId;
      }
      const namespace = yield* observeNamespace(type, name, namespaceId);
      if (namespace?.Id === undefined) {
        return yield* Effect.fail(
          new sd.NamespaceNotFound({
            Message: `namespace ${name} not visible after create`,
          }),
        );
      }
      return namespace;
    }),
  );

/**
 * Fetch the observed Cloud Map tags for a resource ARN as a plain record,
 * tolerating a missing resource (race during create/delete) as `{}`.
 */
export const fetchObservedTags = Effect.fn("AWS.CloudMap.fetchObservedTags")(
  function* (resourceArn: string) {
    const tags = yield* sd
      .listTagsForResource({ ResourceARN: resourceArn })
      .pipe(
        Effect.map((response) => response.Tags ?? []),
        Effect.catch(() => Effect.succeed([] as sd.Tag[])),
      );
    return Object.fromEntries(tags.map((tag) => [tag.Key, tag.Value]));
  },
);

/**
 * Sync a Cloud Map resource's tags: diff the OBSERVED cloud tags against the
 * desired set and apply only the delta via tagResource/untagResource.
 */
export const syncTags = Effect.fn("AWS.CloudMap.syncTags")(function* (
  resourceArn: string,
  observed: Record<string, string>,
  desired: Record<string, string>,
) {
  const { upsert, removed } = diffTags(observed, desired);
  if (upsert.length > 0) {
    yield* sd.tagResource({ ResourceARN: resourceArn, Tags: upsert });
  }
  if (removed.length > 0) {
    yield* sd.untagResource({ ResourceARN: resourceArn, TagKeys: removed });
  }
});
