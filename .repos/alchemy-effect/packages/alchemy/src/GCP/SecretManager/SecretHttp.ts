import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as Effect from "effect/Effect";
import { bindGcpHost } from "../Host.ts";
import { grantFor, type BindingIam } from "../HttpBinding.ts";
import type { SecretBindingTarget } from "./BindingHttp.ts";
import type { ReadSecretClient } from "./ReadSecret.ts";
import type { WriteSecretClient } from "./WriteSecret.ts";

/**
 * Shared HTTP scaffolding for the Secret Manager Read/Write/ReadWrite
 * bindings. NOT exported from `index.ts`.
 */

export const readSecretGrants: BindingIam[] = [
  { role: "roles/secretmanager.secretAccessor", on: "secretmanager.secret" },
];

export const writeSecretGrants: BindingIam[] = [
  {
    role: "roles/secretmanager.secretVersionManager",
    on: "secretmanager.secret",
  },
];

// No predefined role covers access + version management short of
// secretmanager.admin, so ReadWrite grants both narrow roles.
export const readWriteSecretGrants: BindingIam[] = [
  ...readSecretGrants,
  ...writeSecretGrants,
];

const versionName = (secretName: string, version: string) =>
  version.includes("/versions/")
    ? version
    : `${secretName}/versions/${version}`;

export const makeSecretHelpers = Effect.gen(function* () {
  const access = yield* secretmanager.accessProjectsSecretsVersions;
  const addVersion = yield* secretmanager.addVersionProjectsSecrets;
  const disable = yield* secretmanager.disableProjectsSecretsVersions;
  const destroy = yield* secretmanager.destroyProjectsSecretsVersions;

  const makeRead = (secretName: Effect.Effect<string>): ReadSecretClient => {
    const accessBytes = (version?: string) =>
      Effect.gen(function* () {
        const response = yield* access({
          name: versionName(yield* secretName, version ?? "latest"),
        });
        const data = response.payload?.data ?? "";
        return yield* Effect.sync(
          () => new Uint8Array(Buffer.from(data, "base64")),
        );
      }).pipe(
        // Missing, disabled, and destroyed versions have no readable payload.
        Effect.catchTag(["NotFound", "SecretVersionNotEnabled"], () =>
          Effect.succeed(undefined),
        ),
      );
    return {
      accessBytes,
      access: (version) =>
        accessBytes(version).pipe(
          Effect.map((bytes) =>
            bytes === undefined ? undefined : new TextDecoder().decode(bytes),
          ),
        ),
    };
  };

  const makeWrite = (secretName: Effect.Effect<string>): WriteSecretClient => ({
    addVersion: (value) =>
      Effect.gen(function* () {
        const data = yield* Effect.sync(() =>
          (typeof value === "string"
            ? Buffer.from(value, "utf8")
            : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          ).toString("base64"),
        );
        const version = yield* addVersion({
          parent: yield* secretName,
          body: { payload: { data } },
        });
        return version.name ?? "";
      }),
    disableVersion: (version) =>
      Effect.gen(function* () {
        yield* disable({ name: versionName(yield* secretName, version) });
      }),
    destroyVersion: (version) =>
      Effect.gen(function* () {
        yield* destroy({ name: versionName(yield* secretName, version) });
      }).pipe(Effect.catchTag("NotFound", () => Effect.void)),
  });

  return { makeRead, makeWrite };
});

/** Build a secret binding that grants `grants` and returns `makeClient`'s client. */
export const makeSecretAccessBinding = <Client>(options: {
  tag: string;
  grants: BindingIam[];
  makeClient: (
    helpers: Effect.Success<typeof makeSecretHelpers>,
    secretName: Effect.Effect<string>,
  ) => Client;
}) =>
  Effect.gen(function* () {
    const helpers = yield* makeSecretHelpers;
    return Effect.fn(function* (secret: SecretBindingTarget) {
      // `name` is `projects/p/secrets/s` or, for regional secrets,
      // `projects/p/locations/l/secrets/s`; both are secret IAM targets.
      yield* bindGcpHost({
        tag: options.tag,
        resource: secret,
        iam: options.grants.map((grant) => grantFor(grant, secret.name)),
      });
      const secretName = yield* secret.name;
      return options.makeClient(helpers, secretName);
    });
  });
