import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import { waitForOperation as waitForLongRunning, type LongRunningOperation } from "../Operation.ts";

const getOperation = (name: string) =>
  name.includes("/billingAccounts/") || name.startsWith("billingAccounts/")
    ? logging.getBillingAccountsLocationsOperations({ name })
    : name.includes("/folders/") || name.startsWith("folders/")
      ? logging.getFoldersLocationsOperations({ name })
      : name.includes("/organizations/") || name.startsWith("organizations/")
        ? logging.getOrganizationsLocationsOperations({ name })
        : name.includes("/projects/") || name.startsWith("projects/")
          ? logging.getProjectsLocationsOperations({ name })
          : logging.getLocationsOperations({ name });

export const deleteBucketLinks = (bucketName: string) =>
  logging.listLocationsBucketsLinks.pages({ parent: bucketName, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.links ?? [])),
    Stream.runCollect,
    Effect.flatMap((links) =>
      Effect.forEach(
        links,
        (link) => {
          const name = link.name;
          if (name === undefined) return Effect.void;
          return logging.deleteLocationsBucketsLinks({ name }).pipe(
            Effect.catchTag(["NotFound", "Conflict"], () => Effect.void),
            Effect.asVoid,
          );
        },
        { concurrency: 4 },
      ),
    ),
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.asVoid,
  );

export const listProjectBuckets = () =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    return yield* logging.listProjectsLocationsBuckets
      .pages({
        parent: `projects/${env.project}/locations/-`,
        pageSize: 1000,
      })
      .pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.buckets ?? [])),
        Stream.filter((bucket) => (bucket.name ?? "").length > 0),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
  });

/** Linked-dataset creation and bucket analytics upgrades take several minutes. */
const OPERATION_BUDGET = "15 minutes";

/**
 * Wait for a long-running operation. ALREADY_EXISTS (code 6) means a
 * concurrent create won the race; reconcile observes the resource next.
 */
export const waitForOperation = (operation: LongRunningOperation) =>
  waitForLongRunning(operation, getOperation, {
    budget: OPERATION_BUDGET,
  }).pipe(
    Effect.catchIf(
      (error) => error._tag === "GCP.OperationFailed" && error.code === 6,
      () => Effect.succeed(operation),
    ),
  );

/**
 * Wait for a delete operation. A vanished operation or NOT_FOUND (code 5)
 * means the resource is already gone.
 */
export const waitForDeleteOperation = (operation: LongRunningOperation) =>
  waitForOperation(operation).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "NotFound" || (error._tag === "GCP.OperationFailed" && error.code === 5),
      () => Effect.succeed(operation),
    ),
  );
