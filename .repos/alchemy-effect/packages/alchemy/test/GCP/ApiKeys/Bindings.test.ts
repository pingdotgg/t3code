import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as apikeys from "@distilled.cloud/gcp/apikeys_v2";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import ApiKeysBindingsHost, { Maps } from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ApiKeysBindings");

let baseUrl: string;
let keyName: string;
let hostAccount: string;

/** Every project-level role (and its IAM Condition) `account` holds. */
const projectGrantsOf = (account: string) =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;
    const policy = yield* resourcemanager.getIamPolicyProjects({
      resource: `projects/${project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    });
    return (policy.bindings ?? [])
      .filter((binding) =>
        (binding.members ?? []).includes(`serviceAccount:${account}`),
      )
      .map((binding) => ({
        role: binding.role,
        condition: binding.condition?.expression,
      }));
  });

describe.skipIf(!dockerAvailable)(
  "ApiKeys Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:apikeys", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* ApiKeysBindingsHost;
            const key = yield* Maps;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              key: key.name,
            };
          }),
        );
        baseUrl = out.uri!;
        keyName = out.key;
        hostAccount = out.serviceAccount!;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GetKeyString", () => {
      test.provider(
        "reads the key string as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{ keyString?: string }>(
              baseUrl,
              "getKeyString",
            );
            const expected = yield* apikeys.getKeyStringProjectsLocationsKeys({
              name: keyName,
            });
            expect(out.keyString).toEqual(expected.keyString);
            expect(out.keyString?.length ?? 0).toBeGreaterThan(8);

            // API keys have no resource-level IAM policy.
            const grants = yield* projectGrantsOf(hostAccount);
            expect(grants).toEqual([
              {
                role: "roles/serviceusage.apiKeysViewer",
                condition: undefined,
              },
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:apikeys", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
