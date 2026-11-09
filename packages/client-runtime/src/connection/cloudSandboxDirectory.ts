import type { EnvironmentId, ManagedCloudSandboxResource } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
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

const LISTING_TTL_MS = 30_000;

const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const operate = yield* makeManagedCloudSandboxClient;
  const listings = new Map<
    EnvironmentId,
    {
      readonly prepared: PreparedConnection;
      readonly listedAt: number;
      readonly resources: readonly ManagedCloudSandboxResource[];
    }
  >();
  // Only successful listings are cached, so a timeout never hides a sandbox for the TTL.
  const list = Effect.fn("CloudSandboxDirectory.list")(function* (
    controllerId: EnvironmentId,
    refresh: boolean,
  ) {
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
    const now = yield* Clock.currentTimeMillis;
    const cached = listings.get(controllerId);
    if (!refresh && cached?.prepared === controller && now - cached.listedAt < LISTING_TTL_MS)
      return { controller, resources: cached.resources, fresh: false };
    const listed = yield* operate(controller, { _tag: "list" }).pipe(
      Effect.timeout("3 seconds"),
      Effect.map((result) => (result._tag === "list" ? result.resources : null)),
      Effect.orElseSucceed(() => null),
    );
    if (listed === null) return { controller, resources: cached?.resources ?? [], fresh: true };
    listings.set(controllerId, { prepared: controller, listedAt: now, resources: listed });
    return { controller, resources: listed, fresh: true };
  });
  const findAt = Effect.fn("CloudSandboxDirectory.findAt")(function* (
    controllerId: EnvironmentId,
    environmentId: EnvironmentId,
  ) {
    const lookup = (listed: { readonly resources: readonly ManagedCloudSandboxResource[] }) =>
      listed.resources.find(
        (resource) => resource.environmentId === environmentId && resource.phase !== "deleted",
      );
    let listed = yield* list(controllerId, false);
    let resource = listed === null ? undefined : lookup(listed);
    // A sandbox that connected after the cached listing is missing from it.
    if (listed !== null && resource === undefined && !listed.fresh) {
      listed = yield* list(controllerId, true);
      resource = listed === null ? undefined : lookup(listed);
    }
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
