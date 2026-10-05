import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import SecretManagerBindingsHost, {
  OpsSecret,
  ReadOnlySecret,
  ReadWriteOnlySecret,
  RegionalSecret,
  SEEDED,
  WriteOnlySecret,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SecretManagerBindings");

let baseUrl: string;
let hostAccount: string;
let secrets: {
  ops: string;
  regional: string;
  readOnly: string;
  writeOnly: string;
  readWrite: string;
};

const hostRoles = (policy: secretmanager.Policy) =>
  (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => binding.role)
    .sort();

/** Roles the host's service account holds on a global secret. */
const secretRoles = (name: string) =>
  secretmanager
    .getIamPolicyProjectsSecrets({ resource: name })
    .pipe(Effect.map(hostRoles));

/** Roles the host's service account holds on a regional secret. */
const regionalSecretRoles = (name: string) =>
  secretmanager
    .getIamPolicyProjectsLocationsSecrets({ resource: name })
    .pipe(Effect.map(hostRoles));

/** Every version of a secret with its state, read out of band. */
const versionStates = (parent: string) =>
  Effect.gen(function* () {
    const states: Record<string, string | undefined> = {};
    let pageToken: string | undefined;
    do {
      const page = yield* secretmanager.listProjectsSecretsVersions({
        parent,
        pageToken,
      });
      for (const version of page.versions ?? []) {
        if (version.name) states[version.name] = version.state;
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return states;
  });

describe.skipIf(!dockerAvailable)(
  "SecretManager Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:secretmanager",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* SecretManagerBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              ops: (yield* OpsSecret).name,
              regional: (yield* RegionalSecret).name,
              readOnly: (yield* ReadOnlySecret).name,
              writeOnly: (yield* WriteOnlySecret).name,
              readWrite: (yield* ReadWriteOnlySecret).name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        secrets = {
          ops: out.ops,
          regional: out.regional,
          readOnly: out.readOnly,
          writeOnly: out.writeOnly,
          readWrite: out.readWrite,
        };
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("AddSecretVersion / AccessSecretVersion", () => {
      test.provider(
        "round-trip a global secret as the host's service account, granted on the secret only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              version: string;
              accessedName: string;
              data: string;
              payload: string;
            }>(baseUrl, "ops");
            expect(out.version.startsWith(`${secrets.ops}/versions/`)).toBe(
              true,
            );
            expect(out.accessedName).toEqual(out.version);
            expect(out.data).toEqual(out.payload);

            const states = yield* versionStates(secrets.ops);
            expect(states[out.version]).toEqual("ENABLED");

            expect(yield* secretRoles(secrets.ops)).toEqual([
              "roles/secretmanager.secretAccessor",
              "roles/secretmanager.secretVersionAdder",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:secretmanager", "live"],
          timeout: 600_000,
        },
      );

      test.provider(
        "round-trip a regional secret as the host's service account, granted on the secret only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              version: string;
              accessedName: string;
              data: string;
              payload: string;
            }>(baseUrl, "opsRegional");
            expect(
              out.version.startsWith(`${secrets.regional}/versions/`),
            ).toBe(true);
            expect(out.version).toContain("/locations/us-central1/secrets/");
            expect(out.accessedName).toEqual(out.version);
            expect(out.data).toEqual(out.payload);

            expect(yield* regionalSecretRoles(secrets.regional)).toEqual([
              "roles/secretmanager.secretAccessor",
              "roles/secretmanager.secretVersionAdder",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:secretmanager", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ReadSecret", () => {
      test.provider(
        "reads a seeded version as the host's service account, granted secretAccessor on the secret only",
        (_stack) =>
          Effect.gen(function* () {
            yield* secretmanager.addVersionProjectsSecrets({
              parent: secrets.readOnly,
              body: {
                payload: { data: btoa(SEEDED) },
              },
            });
            const out = yield* expectProbe<{
              latest: string;
              bytes: string;
              missing: boolean;
            }>(baseUrl, "read");
            expect(out).toEqual({
              latest: SEEDED,
              bytes: SEEDED,
              missing: true,
            });

            expect(yield* secretRoles(secrets.readOnly)).toEqual([
              "roles/secretmanager.secretAccessor",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:secretmanager", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("WriteSecret", () => {
      test.provider(
        "adds, disables and destroys versions as the host's service account, granted secretVersionManager on the secret only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{ v1: string; v2: string }>(
              baseUrl,
              "write",
            );
            expect(out.v1.startsWith(`${secrets.writeOnly}/versions/`)).toBe(
              true,
            );
            expect(out.v2.startsWith(`${secrets.writeOnly}/versions/`)).toBe(
              true,
            );

            const states = yield* versionStates(secrets.writeOnly);
            expect(states[out.v1]).toEqual("DESTROYED");
            expect(states[out.v2]).toEqual("DISABLED");

            expect(yield* secretRoles(secrets.writeOnly)).toEqual([
              "roles/secretmanager.secretVersionManager",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:secretmanager", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ReadWriteSecret", () => {
      test.provider(
        "rotates and reads back as the host's service account, granted accessor + versionManager on the secret only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              v1: string;
              v2: string;
              latest: string;
              first: string;
              disabledReadsUndefined: boolean;
              destroyedReadsUndefined: boolean;
            }>(baseUrl, "readWrite");
            expect(out).toEqual({
              v1: expect.stringContaining(`${secrets.readWrite}/versions/`),
              v2: expect.stringContaining(`${secrets.readWrite}/versions/`),
              latest: "two",
              first: "one",
              disabledReadsUndefined: true,
              destroyedReadsUndefined: true,
            });

            const states = yield* versionStates(secrets.readWrite);
            expect(states[out.v1]).toEqual("DESTROYED");
            expect(states[out.v2]).toEqual("DISABLED");

            expect(yield* secretRoles(secrets.readWrite)).toEqual([
              "roles/secretmanager.secretAccessor",
              "roles/secretmanager.secretVersionManager",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:secretmanager", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
