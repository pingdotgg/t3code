import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

export const resourceNameFromOperation = (
  operation: aiplatform.GoogleLongrunningOperation,
): string | undefined => {
  const response = operation.response;
  const responseName = response?.name;
  if (typeof responseName === "string" && responseName.length > 0) {
    return responseName;
  }
  const metadata = operation.metadata;
  const target = metadata?.target;
  if (typeof target === "string" && target.length > 0) {
    return target;
  }
  return undefined;
};

/**
 * Wait for a Vertex AI long-running operation and return the finished
 * operation (so callers can read its `response`). Index deploys and
 * feature-store provisioning take up to ~30 minutes.
 *
 * An operation that failed with ALREADY_EXISTS (6) counts as done (a lost
 * create race). With `notFoundOk`, NOT_FOUND (5) — or an operation record
 * that is gone — counts as done too (a lost delete race).
 */
export const waitForOperation = (
  operation: aiplatform.GoogleLongrunningOperation,
  options?: {
    notFoundOk?: boolean;
    alreadyExistsOk?: boolean;
    /**
     * Operation getter for a service that the v1 API does not serve, such as
     * AgentService (v1beta1 only). Defaults to v1 `getProjectsLocationsOperations`.
     */
    get?: (name: string) => ReturnType<typeof aiplatform.getProjectsLocationsOperations>;
  },
) =>
  Effect.gen(function* () {
    const get =
      options?.get ?? ((name: string) => aiplatform.getProjectsLocationsOperations({ name }));
    const finished = yield* waitForGcpOperation(operation, get, {
      budget: "30 minutes",
    }).pipe(
      Effect.as(true),
      Effect.catchTags({
        "GCP.OperationFailed": (error) =>
          error.code === 6 || (options?.notFoundOk === true && error.code === 5)
            ? Effect.succeed(false)
            : Effect.fail(error),
        NotFound: (error) =>
          options?.notFoundOk === true ? Effect.succeed(false) : Effect.fail(error),
      }),
    );
    if (!finished || operation.done === true || !operation.name) {
      return operation;
    }
    return yield* get(operation.name);
  });

/**
 * Vertex AI hides a resource from `get` / `list` until its create
 * operation finishes. On a freshly provisioned project that took 4–9
 * minutes for endpoints, indexes, index endpoints and deployment
 * resource pools, so a deploy interrupted in that window leaves a
 * resource that a plain lookup cannot see — the recovery `read` /
 * `delete` would report it gone and leak it once the create completes.
 *
 * `settlePendingCreates` waits for every unfinished create operation on
 * `{location}/{collection}` (optionally only `{collection}/{resourceId}`)
 * and reports whether any were found, so callers re-run their lookup
 * afterwards. It only waits — it never acts on resources it can't
 * attribute — so it is safe for server-assigned ids, where the pending
 * operation carries no ownership labels.
 */
export const settlePendingCreates = (options: {
  /** `projects/{project}/locations/{location}` */
  parent: string;
  /** Collection segment, e.g. `indexes`, `endpoints`. */
  collection: string;
  /** Restrict to one resource id (deterministic-id resources). */
  resourceId?: string;
}) =>
  Effect.gen(function* () {
    const prefix =
      options.resourceId !== undefined
        ? `${options.parent}/${options.collection}/${options.resourceId}/operations/`
        : `${options.parent}/${options.collection}/`;
    // Operation names use the project NUMBER while callers usually hold
    // the project ID, so match on the location-relative suffix.
    const relative = prefix.slice(prefix.indexOf("/locations/"));
    const pending = yield* aiplatform.listProjectsLocationsOperations
      .pages({ name: options.parent, filter: "done=false", pageSize: 100 })
      .pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.operations ?? [])),
        Stream.filter((operation) => {
          const name = operation.name ?? "";
          const rawType = operation.metadata?.["@type"];
          const type = typeof rawType === "string" ? rawType : "";
          return (
            operation.done !== true &&
            name.includes(relative) &&
            /\.Create[A-Za-z]*OperationMetadata$/.test(type)
          );
        }),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () =>
          Effect.succeed([] as aiplatform.GoogleLongrunningOperation[]),
        ),
      );
    if (pending.length === 0) return false;
    yield* Effect.logInfo(
      `Waiting for ${pending.length} pending Vertex AI create operation(s) on ${options.collection} before looking up the resource`,
    );
    yield* Effect.forEach(
      pending,
      (operation) =>
        waitForOperation(operation, { notFoundOk: true }).pipe(
          // A failed create produced nothing to recover.
          Effect.catchTag("GCP.OperationFailed", () => Effect.void),
          Effect.asVoid,
        ),
      { concurrency: 4, discard: true },
    );
    return true;
  });
