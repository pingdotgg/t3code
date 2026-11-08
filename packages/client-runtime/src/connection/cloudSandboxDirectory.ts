import type { EnvironmentId, ManagedCloudSandboxResource } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { PreparedConnection } from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import { makeManagedCloudSandboxClient } from "./managedCloudSandbox.ts";

interface SandboxOwner {
  readonly controller: PreparedConnection;
  readonly resource: ManagedCloudSandboxResource;
}

export class CloudSandboxDirectory extends Context.Service<
  CloudSandboxDirectory,
  {
    readonly find: (environmentId: EnvironmentId) => Effect.Effect<SandboxOwner | null>;
  }
>()("@t3tools/client-runtime/connection/cloudSandboxDirectory") {}

const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const operate = yield* makeManagedCloudSandboxClient;
  const listings = new Map<
    EnvironmentId,
    {
      readonly prepared: PreparedConnection;
      readonly read: Effect.Effect<readonly ManagedCloudSandboxResource[]>;
    }
  >();
  const list = Effect.fn("CloudSandboxDirectory.list")(function* (controllerId: EnvironmentId) {
    const prepared = yield* registry
      .run(
        controllerId,
        EnvironmentSupervisor.EnvironmentSupervisor.pipe(
          Effect.flatMap((supervisor) => SubscriptionRef.get(supervisor.prepared)),
        ),
      )
      .pipe(Effect.option);
    if (Option.isNone(prepared) || Option.isNone(prepared.value)) return null;
    const controller = prepared.value.value;
    let cached = listings.get(controllerId);
    if (cached?.prepared !== controller) {
      const read = yield* operate(controller, { _tag: "list" }).pipe(
        Effect.timeout("3 seconds"),
        Effect.map((result) => (result._tag === "list" ? result.resources : [])),
        Effect.orElseSucceed(() => []),
        Effect.cachedWithTTL("30 seconds"),
      );
      cached = { prepared: controller, read };
      listings.set(controllerId, cached);
    }
    return { controller, resources: yield* cached.read };
  });
  const findAt = Effect.fn("CloudSandboxDirectory.findAt")(function* (
    controllerId: EnvironmentId,
    environmentId: EnvironmentId,
  ) {
    const listed = yield* list(controllerId);
    const resource = listed?.resources.find(
      (resource) => resource.environmentId === environmentId && resource.phase !== "deleted",
    );
    return listed !== null && resource !== undefined
      ? { controller: listed.controller, resource }
      : null;
  });
  return CloudSandboxDirectory.of({
    find: Effect.fn("CloudSandboxDirectory.find")(function* (environmentId) {
      const entries = yield* SubscriptionRef.get(registry.entries);
      for (const controllerId of listings.keys()) {
        if (!entries.has(controllerId)) listings.delete(controllerId);
      }
      const entry = entries.get(environmentId);
      const profile = entry === undefined ? null : Option.getOrNull(entry.profile);
      if (profile?._tag !== "CloudSandboxConnectionProfile") return null;
      return yield* findAt(profile.controller.environmentId, environmentId);
    }),
  });
});

export const layer = Layer.effect(CloudSandboxDirectory, make);
