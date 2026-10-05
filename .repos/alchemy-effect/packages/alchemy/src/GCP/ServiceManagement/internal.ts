import * as servicemanagement from "@distilled.cloud/gcp/servicemanagement_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  waitForOperation as waitForLongRunning,
  type LongRunningOperation,
} from "../Operation.ts";

export const MAX_LABEL_LENGTH = 63;
export const GENERATED_LABEL_LENGTH = 40;

export class ServiceNotResolved extends Data.TaggedError(
  "GCP.ServiceManagement.ServiceNotResolved",
)<{
  serviceName: string;
}> {}

export class ServiceStillExists extends Data.TaggedError(
  "GCP.ServiceManagement.ServiceStillExists",
)<{
  serviceName: string;
}> {}

export const endpointsSuffix = (project: string) =>
  `.endpoints.${project}.cloud.goog`;

export const isGeneratedServiceName = (
  serviceName: string,
  project: string,
) => {
  const suffix = endpointsSuffix(project);
  return (
    serviceName.startsWith("alch-") &&
    serviceName.endsWith(suffix) &&
    serviceName.length > suffix.length
  );
};

const dnsLabel = (value: string) => {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/g, "")
    .slice(0, MAX_LABEL_LENGTH)
    .replace(/-+$/g, "");
  const named = /^[a-z]/.test(cleaned) ? cleaned : `a${cleaned}`;
  return named.slice(0, MAX_LABEL_LENGTH).replace(/-+$/g, "");
};

export const toServiceName = (
  id: string,
  serviceName: string | undefined,
  existing: string | undefined,
  project: string,
) =>
  Effect.gen(function* () {
    if (serviceName !== undefined && serviceName.length > 0) {
      return serviceName;
    }
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength: GENERATED_LABEL_LENGTH,
      lowercase: true,
    });
    const label = dnsLabel(
      generated.startsWith("alch-") ? generated : `alch-${generated}`,
    );
    return `${label}${endpointsSuffix(project)}`;
  });

/**
 * Service Management answers a missing service with HTTP 403 "not found or
 * permission denied", typed as `ServiceNotFound`.
 */
export const getByName = (serviceName: string) =>
  servicemanagement
    .getServices({ serviceName })
    .pipe(
      Effect.catchTag(["NotFound", "ServiceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

/** The newest config version (the list is ordered newest first). */
export const getLatestConfig = (serviceName: string) =>
  servicemanagement.listServicesConfigs({ serviceName, pageSize: 1 }).pipe(
    Effect.map((page) => page.serviceConfigs?.[0]),
    Effect.catchTag(["NotFound", "ServiceNotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

export const waitUntilExists = (serviceName: string) =>
  getByName(serviceName).pipe(
    Effect.flatMap((service) =>
      service !== undefined
        ? Effect.succeed(service)
        : Effect.fail(new ServiceNotResolved({ serviceName })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ServiceManagement.ServiceNotResolved",
      times: 20,
      schedule: Schedule.spaced("6 seconds"),
    }),
  );

export const waitUntilGone = (serviceName: string) =>
  getByName(serviceName).pipe(
    Effect.flatMap((service) =>
      service === undefined
        ? Effect.void
        : Effect.fail(new ServiceStillExists({ serviceName })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ServiceManagement.ServiceStillExists",
      times: 10,
      schedule: Schedule.spaced("4 seconds"),
    }),
  );

export const undeleteService = (serviceName: string) =>
  Effect.gen(function* () {
    const operation = yield* servicemanagement
      .undeleteServices({ serviceName })
      .pipe(
        Effect.catchTag(
          ["NotFound", "ServiceNotFound", "ServiceAlreadyActive"],
          () => Effect.succeed(undefined),
        ),
      );
    if (operation !== undefined) {
      yield* waitForOperation(operation);
    }
    return yield* getByName(serviceName);
  });

export const listProducerServices = (project: string) =>
  servicemanagement.listServices
    .pages({
      producerProjectId: project,
      pageSize: 500,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.services ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as servicemanagement.ManagedService[]),
      ),
    );

/** Managed-service creates and deletes routinely run past three minutes. */
const OPERATION_BUDGET = "10 minutes";

/**
 * Wait for a long-running operation. ALREADY_EXISTS (code 6) means a
 * concurrent create won the race; reconcile observes the resource next.
 */
export const waitForOperation = (operation: LongRunningOperation) =>
  waitForLongRunning(
    operation,
    (name) => servicemanagement.getOperations({ name }),
    {
      budget: OPERATION_BUDGET,
    },
  ).pipe(
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
        error._tag === "NotFound" ||
        (error._tag === "GCP.OperationFailed" && error.code === 5),
      () => Effect.succeed(operation),
    ),
  );
