import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { buildSnapshotSource } from "./ProviderRegistry.ts";

const makeCursorInstance = (input: { readonly skillInventory: boolean }): ProviderInstance => {
  const cursorDriver = ProviderDriverKind.make("cursor");
  const cursorInstanceId = ProviderInstanceId.make("cursor");
  const provider = {
    instanceId: cursorInstanceId,
    driver: cursorDriver,
    status: "ready",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    checkedAt: "2026-07-31T00:00:00.000Z",
    version: "1.0.0",
    models: [],
    slashCommands: [],
    skills: [],
  } as const satisfies ServerProvider;
  return {
    instanceId: cursorInstanceId,
    driverKind: cursorDriver,
    continuationIdentity: {
      driverKind: cursorDriver,
      continuationKey: "cursor:instance:cursor",
    },
    displayName: undefined,
    enabled: true,
    snapshot: {
      maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
        provider: cursorDriver,
        packageName: null,
      }),
      getSnapshot: Effect.succeed(provider),
      refresh: Effect.succeed(provider),
      streamChanges: Stream.make(provider),
    },
    adapter: {} as ProviderInstance["adapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
    ...(input.skillInventory ? { skillInventory: { list: () => Effect.succeed([]) } } : {}),
  } satisfies ProviderInstance;
};

const collectSnapshotsFromEveryChannel = (instance: ProviderInstance) =>
  Effect.gen(function* () {
    const source = buildSnapshotSource(instance);
    const streamed = yield* Stream.runCollect(source.streamChanges);
    return [yield* source.getSnapshot, yield* source.refresh, ...streamed];
  });

it.effect("derives project-scoped skill inventory on every snapshot channel", () =>
  Effect.gen(function* () {
    const snapshots = yield* collectSnapshotsFromEveryChannel(
      makeCursorInstance({ skillInventory: true }),
    );

    assert.isTrue(snapshots.every((snapshot) => snapshot.skillInventoryMode === "project"));
  }),
);

it.effect("leaves snapshot-mode providers unmarked", () =>
  Effect.gen(function* () {
    // Clients read `skills` when `skillInventoryMode` is absent, so this
    // branch is what keeps every non-Cursor provider on the zero-round-trip
    // picker.
    const snapshots = yield* collectSnapshotsFromEveryChannel(
      makeCursorInstance({ skillInventory: false }),
    );

    assert.isTrue(snapshots.every((snapshot) => snapshot.skillInventoryMode === undefined));
  }),
);
