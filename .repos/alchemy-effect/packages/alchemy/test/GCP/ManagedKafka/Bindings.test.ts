import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import KafkaBindingsHost, {
  Brokers,
  Connect,
  Events,
  Schemas,
} from "./fixtures/bindings-host.ts";
import { releaseKafkaClusterSlot, takeKafkaClusterSlot } from "./quota.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ManagedKafkaBindings");

// Kafka and Connect clusters take ~30 minutes to provision.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

let baseUrl: string;
let hostAccount: string;
let clusterName: string;
let topicName: string;
let connectName: string;
let registryName: string;

/**
 * Managed Kafka has no per-resource IAM policy: bindings grant on the
 * project under an IAM Condition matching the bound resource.
 */
const hostProjectGrants = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const policy = yield* resourcemanager.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  return (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => ({
      role: binding.role,
      condition: binding.condition?.expression,
    }));
});

/** Granted on the project, unconditioned (see GetSchemaRegistryHttp). */
const SCHEMA_REGISTRY_ROLE = "roles/managedkafka.schemaRegistryViewer";

const scopedTo = (name: string) =>
  `resource.name == "${name}" || resource.name.startsWith("${name}/")`;

/** The host holds `role` only under the condition scoped to `name`. */
const expectScopedGrant = (role: string, name: string) =>
  Effect.gen(function* () {
    const grants = yield* hostProjectGrants;
    expect(grants).toContainEqual({ role, condition: scopedTo(name) });
    expect(grants).toEqual(
      expect.arrayContaining([
        { role: SCHEMA_REGISTRY_ROLE, condition: undefined },
      ]),
    );
    // Every grant except the schema-registry viewer is condition-scoped.
    expect(
      grants
        .filter((grant) => grant.role !== SCHEMA_REGISTRY_ROLE)
        .every((grant) => grant.condition !== undefined),
    ).toBe(true);
    expect(grants).toHaveLength(4);
  });

describe.skipIf(!dockerAvailable || !runLifecycle)(
  "ManagedKafka Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:managedkafka",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* takeKafkaClusterSlot;
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* KafkaBindingsHost;
            const cluster = yield* Brokers;
            const topic = yield* Events;
            const connect = yield* Connect;
            const registry = yield* Schemas;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              cluster: cluster.name,
              topic: topic.name,
              connect: connect.name,
              registry: registry.name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        clusterName = out.cluster;
        topicName = out.topic;
        connectName = out.connect;
        registryName = out.registry;
      }),
      { timeout: 10_800_000 },
    );

    afterAll(
      sharedStack.destroy().pipe(Effect.ensuring(releaseKafkaClusterSlot)),
      { timeout: 3_600_000 },
    );

    describe("GetCluster", () => {
      test.provider(
        "reads the cluster as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<kafka.Cluster>(
              baseUrl,
              "getCluster",
            );
            const direct = yield* kafka.getProjectsLocationsClusters({
              name: clusterName,
            });
            expect(out.name).toEqual(clusterName);
            expect(out.state).toEqual(direct.state);
            yield* expectScopedGrant("roles/managedkafka.viewer", clusterName);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:managedkafka", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetTopic", () => {
      test.provider(
        "reads the topic as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<kafka.Topic>(baseUrl, "getTopic");
            const direct = yield* kafka.getProjectsLocationsClustersTopics({
              name: topicName,
            });
            expect(out.name).toEqual(topicName);
            expect(out.partitionCount).toEqual(direct.partitionCount);
            yield* expectScopedGrant("roles/managedkafka.viewer", topicName);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:managedkafka", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetConnectCluster", () => {
      test.provider(
        "reads the Connect cluster as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<kafka.ConnectCluster>(
              baseUrl,
              "getConnectCluster",
            );
            const direct = yield* kafka.getProjectsLocationsConnectClusters({
              name: connectName,
            });
            expect(out.name).toEqual(connectName);
            expect(out.kafkaCluster).toEqual(direct.kafkaCluster);
            yield* expectScopedGrant("roles/managedkafka.viewer", connectName);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:managedkafka", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetSchemaRegistry", () => {
      test.provider(
        "reads the schema registry as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<kafka.SchemaRegistry>(
              baseUrl,
              "getSchemaRegistry",
            );
            const direct = yield* kafka.getProjectsLocationsSchemaRegistries({
              name: registryName,
            });
            expect(out.name).toEqual(registryName);
            expect(out.contexts).toEqual(direct.contexts);
            const grants = yield* hostProjectGrants;
            expect(grants).toContainEqual({
              role: SCHEMA_REGISTRY_ROLE,
              condition: undefined,
            });
            expect(grants).toHaveLength(4);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:managedkafka", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
