import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";
import { CAPACITY_REGION, CAPACITY_ZONE } from "../../zones.ts";

/** BASIC_HDD instance: draws on the standard-storage quota and supports backups. */
export const Nfs = GCP.Filestore.Instance("Nfs", {
  location: CAPACITY_ZONE,
  tier: "BASIC_HDD",
  fileShares: [{ name: "share1", capacityGb: 1024 }],
});

export const Nightly = Effect.gen(function* () {
  const instance = yield* Nfs;
  return yield* GCP.Filestore.Backup("Nightly", {
    sourceInstance: instance.name,
    sourceFileShare: "share1",
    location: CAPACITY_REGION,
  });
});

/**
 * Effect-native Cloud Run service exercising the instance and backup
 * bindings as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class FilestoreBindingsHost extends GCP.Function<FilestoreBindingsHost>()(
  "FilestoreBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getInstance = yield* GCP.Filestore.GetInstance(yield* Nfs);
    const getBackup = yield* GCP.Filestore.GetBackup(yield* Nightly);

    return {
      fetch: serveProbes({
        getInstance: getInstance(),
        getBackup: getBackup(),
      }),
    };
  }).pipe(
    Effect.provide(GCP.Filestore.GetInstanceHttp),
    Effect.provide(GCP.Filestore.GetBackupHttp),
  ),
) {}
