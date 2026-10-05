import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { serveProbes } from "../../bindingHost.ts";

/** Secret the per-operation AddSecretVersion / AccessSecretVersion bind. */
export const OpsSecret = GCP.SecretManager.Secret("OpsSecret", {});

/** Regional secret the per-operation bindings bind. */
export const RegionalSecret = GCP.SecretManager.LocationsSecret(
  "RegionalSecret",
  { location: "us-central1" },
);

/** Secret only {@link GCP.SecretManager.ReadSecret} binds (seeded by the test). */
export const ReadOnlySecret = GCP.SecretManager.Secret("ReadOnlySecret", {});

/** Secret only {@link GCP.SecretManager.WriteSecret} binds. */
export const WriteOnlySecret = GCP.SecretManager.Secret("WriteOnlySecret", {});

/** Secret only {@link GCP.SecretManager.ReadWriteSecret} binds. */
export const ReadWriteOnlySecret = GCP.SecretManager.Secret(
  "ReadWriteOnlySecret",
  {},
);

/** Payload the test seeds into {@link ReadOnlySecret}. */
export const SEEDED = "seeded-value";

/**
 * Effect-native Cloud Run service exercising every Secret Manager binding as
 * its own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class SecretManagerBindingsHost extends GCP.Function<SecretManagerBindingsHost>()(
  "SecretManagerBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const addVersion = yield* GCP.SecretManager.AddSecretVersion(OpsSecret);
    const access = yield* GCP.SecretManager.AccessSecretVersion(OpsSecret);
    const addRegional =
      yield* GCP.SecretManager.AddSecretVersion(RegionalSecret);
    const accessRegional =
      yield* GCP.SecretManager.AccessSecretVersion(RegionalSecret);
    const reader = yield* GCP.SecretManager.ReadSecret(ReadOnlySecret);
    const writer = yield* GCP.SecretManager.WriteSecret(WriteOnlySecret);
    const both = yield* GCP.SecretManager.ReadWriteSecret(ReadWriteOnlySecret);

    const roundTrip = (
      add: typeof addVersion,
      read: typeof access,
      value: string,
    ) =>
      Effect.gen(function* () {
        const payload = btoa(value);
        const version = yield* add({ payload: { data: payload } });
        const accessed = yield* read({
          version: version.name?.split("/").pop(),
        });
        return {
          version: version.name,
          accessedName: accessed.name,
          data: accessed.payload?.data,
          payload,
        };
      });

    return {
      fetch: serveProbes({
        ops: roundTrip(addVersion, access, "per-op-global"),
        opsRegional: roundTrip(addRegional, accessRegional, "per-op-regional"),
        read: Effect.gen(function* () {
          const latest = yield* reader.access();
          const bytes = yield* reader.accessBytes("latest");
          const missing = yield* reader.access("999");
          return {
            latest,
            bytes: bytes && new TextDecoder().decode(bytes),
            missing: missing === undefined,
          };
        }),
        write: Effect.gen(function* () {
          const v1 = yield* writer.addVersion("one");
          const v2 = yield* writer.addVersion(new TextEncoder().encode("two"));
          yield* writer.disableVersion(v2);
          yield* writer.destroyVersion(v1.split("/").pop() ?? v1);
          yield* writer.destroyVersion("999");
          return { v1, v2 };
        }),
        readWrite: Effect.gen(function* () {
          const v1 = yield* both.addVersion("one");
          const v2 = yield* both.addVersion(new TextEncoder().encode("two"));
          const latest = yield* both.access();
          const first = yield* both.accessBytes(v1);
          yield* both.disableVersion(v2);
          const disabled = yield* Effect.result(both.access(v2));
          yield* both.destroyVersion(v1);
          const destroyed = yield* both.access(v1);
          return {
            v1,
            v2,
            latest,
            first: first && new TextDecoder().decode(first),
            disabledReadsUndefined:
              Result.isSuccess(disabled) && disabled.success === undefined,
            destroyedReadsUndefined: destroyed === undefined,
          };
        }),
      }),
    };
  }).pipe(
    Effect.provide(GCP.SecretManager.AddSecretVersionHttp),
    Effect.provide(GCP.SecretManager.AccessSecretVersionHttp),
    Effect.provide(GCP.SecretManager.ReadSecretHttp),
    Effect.provide(GCP.SecretManager.WriteSecretHttp),
    Effect.provide(GCP.SecretManager.ReadWriteSecretHttp),
  ),
) {}
