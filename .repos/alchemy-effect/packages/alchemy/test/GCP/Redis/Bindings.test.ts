import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as redis from "@distilled.cloud/gcp/redis_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import RedisBindingsHost, {
  Acl,
  Cache,
  WRITTEN_VALUE,
  slow,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RedisBindings");

let baseUrl: string;
let member: string;
let aclName: string;
let cacheName: string | undefined;

const scoped = (name: string) =>
  `resource.name == "${name}" || resource.name.startsWith("${name}/")`;

/**
 * `[role, condition expression]` the host holds on the project: Memorystore
 * has no resource-level IAM, so every grant is a project grant narrowed by
 * an IAM Condition on the bound resource's name.
 */
const hostProjectGrants = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const policy = yield* resourcemanager.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  return (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(member))
    .map((binding) => [binding.role, binding.condition?.expression]);
});

describe.skipIf(!dockerAvailable)(
  "Redis Bindings",
  { tags: ["provider:gcp", "provider:gcp:redis", "provider:gcp:run", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* RedisBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              acl: (yield* Acl).name,
              cache: slow ? (yield* Cache).name : undefined,
            };
          }),
        );
        baseUrl = out.uri!;
        member = `serviceAccount:${out.serviceAccount!}`;
        aclName = out.acl;
        cacheName = out.cache;
      }),
      { timeout: 2_400_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 1_800_000 });

    describe("GetAclPolicy", () => {
      test.provider(
        "reads the ACL policy, granted viewer scoped to it",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<redis.AclPolicy>(
              baseUrl,
              "getAclPolicy",
            );
            expect(live.name).toEqual(aclName);
            expect(live.rules).toEqual([
              { username: "reader", rule: "on ~cache:* +get" },
            ]);
            expect(yield* hostProjectGrants).toContainEqual([
              "roles/redis.viewer",
              scoped(aclName),
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:redis", "live"],
          timeout: 600_000,
        },
      );
    });

    // Memorystore instance create + delete runs well past 5 minutes.
    describe.skipIf(!slow)("GetInstance", () => {
      test.provider(
        "reads the instance, granted viewer scoped to it",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<redis.Instance>(
              baseUrl,
              "getInstance",
            );
            expect(live.name).toEqual(cacheName);
            expect(live.authEnabled).toEqual(true);
            expect(yield* hostProjectGrants).toContainEqual([
              "roles/redis.viewer",
              scoped(cacheName!),
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:redis", "live"],
          timeout: 600_000,
        },
      );
    });

    describe.skipIf(!slow)("GetAuthString", () => {
      test.provider(
        "reads the AUTH string, granted admin scoped to the instance",
        (_stack) =>
          Effect.gen(function* () {
            const auth = yield* expectProbe<redis.InstanceAuthString>(
              baseUrl,
              "getAuthString",
            );
            const direct = yield* redis.getAuthStringProjectsLocationsInstances(
              { name: cacheName! },
            );
            expect(auth.authString).toEqual(direct.authString);
            expect(auth.authString?.length ?? 0).toBeGreaterThan(0);
            expect(yield* hostProjectGrants).toContainEqual([
              "roles/redis.admin",
              scoped(cacheName!),
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:redis", "live"],
          timeout: 600_000,
        },
      );
    });

    describe.skipIf(!slow)("WriteRedis", () => {
      test.provider(
        "writes over AUTH, the AUTH lookup granted admin scoped to the instance",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{ incremented: number }>(
              baseUrl,
              "writeRedis",
            );
            expect(out.incremented).toBeGreaterThan(0);
            expect(yield* hostProjectGrants).toContainEqual([
              "roles/redis.admin",
              scoped(cacheName!),
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:redis", "live"],
          timeout: 600_000,
        },
      );
    });

    describe.skipIf(!slow)("ReadRedis", () => {
      test.provider(
        "reads what WriteRedis wrote, over AUTH",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              value: string | null;
              exists: number;
              pong: string;
            }>(baseUrl, "readRedis");
            expect(out).toEqual({
              value: WRITTEN_VALUE,
              exists: 1,
              pong: "PONG",
            });
          }),
        {
          tags: ["provider:gcp", "provider:gcp:redis", "live"],
          timeout: 600_000,
        },
      );
    });

    describe.skipIf(!slow)("ReadWriteRedis", () => {
      test.provider(
        "round-trips a key over AUTH",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              value: string | null;
              deleted: number;
            }>(baseUrl, "readWriteRedis");
            expect(out).toEqual({ value: "rw", deleted: 1 });

            const grants = yield* hostProjectGrants;
            // Every grant is condition-scoped; nothing lands on the whole
            // project.
            expect(grants.filter(([, expression]) => !expression)).toEqual([]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:redis", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
