import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

export const retryIdentityCenter = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: (error: any) =>
        error?._tag === "ConflictException" ||
        error?._tag === "ThrottlingException" ||
        error?._tag === "InternalServerException",
      schedule: Schedule.exponential(200).pipe(
        Schedule.both(Schedule.recurs(8)),
      ),
    }),
  );

export const listInstances = Effect.fn(function* () {
  return yield* ssoAdmin.listInstances
    .items({
      MaxResults: 100,
    })
    .pipe(
      Stream.runCollect,
      Effect.map(
        (instances) => Array.from(instances) as ssoAdmin.InstanceMetadata[],
      ),
    );
});

export const resolveInstance = Effect.fn(function* (instanceArn?: string) {
  const instances = yield* listInstances();

  if (instanceArn) {
    const selected = instances.find(
      (instance) => instance.InstanceArn === instanceArn,
    );
    if (!selected?.InstanceArn || !selected.IdentityStoreId) {
      return yield* Effect.fail(
        new Error(`Identity Center instance '${instanceArn}' was not found`),
      );
    }
    return selected;
  }

  if (instances.length === 1) {
    return instances[0]!;
  }

  const active = instances.filter((instance) => instance.Status === "ACTIVE");
  if (active.length === 1) {
    return active[0]!;
  }

  return yield* Effect.fail(
    new Error(
      "Unable to resolve a single visible Identity Center instance; pass instanceArn explicitly",
    ),
  );
});

export const resolveIdentityStoreId = Effect.fn(function* ({
  identityStoreId,
  instanceArn,
}: {
  identityStoreId?: string;
  instanceArn?: string;
}) {
  if (identityStoreId) {
    return identityStoreId;
  }

  const instance = yield* resolveInstance(instanceArn);
  if (!instance.IdentityStoreId) {
    return yield* Effect.fail(
      new Error(
        `Identity Center instance '${instance.InstanceArn}' is missing an identity store ID`,
      ),
    );
  }

  return instance.IdentityStoreId;
});

export const toInstanceAttributes = (
  instance: ssoAdmin.InstanceMetadata,
): {
  instanceArn: string;
  identityStoreId: string;
  ownerAccountId: string | undefined;
  name: string | undefined;
  status: string | undefined;
  statusReason: string | undefined;
  createdDate: Date | undefined;
} => ({
  instanceArn: instance.InstanceArn ?? "",
  identityStoreId: instance.IdentityStoreId ?? "",
  ownerAccountId: instance.OwnerAccountId,
  name: instance.Name,
  status: instance.Status,
  statusReason: instance.StatusReason,
  createdDate: instance.CreatedDate,
});

export const listGroups = Effect.fn(function* (identityStoreId: string) {
  return yield* identitystore.listGroups
    .items({
      IdentityStoreId: identityStoreId,
      MaxResults: 100,
    })
    .pipe(
      Stream.runCollect,
      Effect.map((groups) => Array.from(groups) as identitystore.Group[]),
    );
});
