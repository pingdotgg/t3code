import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import type * as memcache from "@distilled.cloud/gcp/memcache_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import MemcacheBindingsHost, {
  Cache,
  memcacheEnabled,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "MemcacheBindings");

let baseUrl: string;
let hostAccount: string;
let project: string;
let instanceName: string;

describe.skipIf(!dockerAvailable || !memcacheEnabled)(
  "Memcache Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:memcache", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* MemcacheBindingsHost;
            const cache = yield* Cache;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              name: cache.name,
              project: cache.project,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        instanceName = out.name;
        project = out.project;
      }),
      { timeout: 1_800_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 1_200_000 });

    describe("GetInstance", () => {
      test.provider(
        "reads the instance as the host's service account, granted memcache.viewer on the project",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<memcache.Instance>(
              baseUrl,
              "getInstance",
            );
            expect(live.name).toEqual(instanceName);
            expect(live.state).toEqual("READY");

            // Memcache instances have no IAM policy of their own.
            const policy = yield* crm.getIamPolicyProjects({
              resource: `projects/${project}`,
              body: { options: { requestedPolicyVersion: 3 } },
            });
            const roles = (policy.bindings ?? [])
              .filter((binding) =>
                (binding.members ?? []).includes(
                  `serviceAccount:${hostAccount}`,
                ),
              )
              .map((binding) => ({
                role: binding.role,
                condition: binding.condition,
              }));
            expect(roles).toEqual([
              { role: "roles/memcache.viewer", condition: undefined },
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:memcache", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
