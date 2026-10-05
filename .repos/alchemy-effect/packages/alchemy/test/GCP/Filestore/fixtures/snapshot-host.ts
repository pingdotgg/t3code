import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";
import { CAPACITY_ZONE } from "../../zones.ts";

/** ZONAL instance: snapshots are unsupported on the BASIC tiers. */
export const ZonalNfs = GCP.Filestore.Instance("ZonalNfs", {
  location: CAPACITY_ZONE,
  tier: "ZONAL",
  fileShares: [{ name: "share1", capacityGb: 1024 }],
});

export const Snap = Effect.gen(function* () {
  const instance = yield* ZonalNfs;
  return yield* GCP.Filestore.InstancesSnapshot("Snap", {
    instance: instance.name,
  });
});

/**
 * Effect-native Cloud Run service exercising the snapshot binding as its own
 * runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class FilestoreSnapshotBindingsHost extends GCP.Function<FilestoreSnapshotBindingsHost>()(
  "FilestoreSnapshotBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getSnapshot = yield* GCP.Filestore.GetInstancesSnapshot(yield* Snap);

    return {
      fetch: serveProbes({
        getInstancesSnapshot: getSnapshot(),
      }),
    };
  }).pipe(Effect.provide(GCP.Filestore.GetInstancesSnapshotHttp)),
) {}
