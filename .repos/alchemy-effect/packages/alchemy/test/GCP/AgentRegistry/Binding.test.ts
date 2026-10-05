import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as registry from "@distilled.cloud/gcp/agentregistry_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Agent Registry is not enabled in the test project (ServiceDisabled, see
// the probe below). Set GCP_TEST_AGENT_REGISTRY=1 in a project that has it.
const runLifecycle = !!process.env.GCP_TEST_AGENT_REGISTRY && !process.env.FAST;

const location = "us-central1";
const currentParent = GcpEnvironment.current.pipe(
  Effect.map(({ project }) => `projects/${project}/locations/${location}`),
);

const waitUntilGone = (name: string) =>
  registry.getProjectsLocationsBindings({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitForOp = (operation: registry.Operation) =>
  registry.getProjectsLocationsOperations({ name: operation.name ?? "" }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (op) => op.done === true,
      times: 30,
    }),
  );

const getService = (name: string) =>
  registry
    .getProjectsLocationsServices({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const ensureService = (input: {
  serviceId: string;
  displayName: string;
  body: registry.Service;
}) =>
  Effect.gen(function* () {
    const parent = yield* currentParent;
    const name = `${parent}/services/${input.serviceId}`;
    const existing = yield* getService(name);
    if (existing !== undefined) return existing;
    const created = yield* registry
      .createProjectsLocationsServices({
        parent,
        serviceId: input.serviceId,
        body: {
          displayName: input.displayName,
          ...input.body,
        },
      })
      .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
    if (created !== undefined) {
      yield* waitForOp(created);
    }
    return yield* registry.getProjectsLocationsServices({ name });
  });

const deleteService = (name: string) =>
  Effect.gen(function* () {
    const deleted = yield* registry
      .deleteProjectsLocationsServices({ name })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (deleted !== undefined) {
      yield* waitForOp(deleted);
    }
  });

const identifierOf = (service: registry.Service) =>
  Effect.gen(function* () {
    const resourceName = service.registryResource;
    if (resourceName === undefined || resourceName.length === 0) {
      return undefined;
    }
    if (resourceName.includes("/agents/")) {
      const agent = yield* registry
        .getProjectsLocationsAgents({ name: resourceName })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      return agent?.agentId;
    }
    if (resourceName.includes("/endpoints/")) {
      const endpoint = yield* registry
        .getProjectsLocationsEndpoints({ name: resourceName })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      return endpoint?.endpointId;
    }
    if (resourceName.includes("/mcpServers/")) {
      const mcp = yield* registry
        .getProjectsLocationsMcpServers({ name: resourceName })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      return mcp?.mcpServerId;
    }
    return undefined;
  });

const waitForIdentifier = (serviceName: string) =>
  getService(serviceName).pipe(
    Effect.flatMap((service) =>
      service === undefined ? Effect.succeed(undefined) : identifierOf(service),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (id) => typeof id === "string" && id.length > 0,
      times: 10,
    }),
  );

const ensureFixtures = () =>
  Effect.gen(function* () {
    const parent = yield* currentParent;
    const sourceService = yield* ensureService({
      serviceId: "alchagregsrc",
      displayName: "alchemy-agentregistry-source",
      body: {
        agentSpec: { type: "NO_SPEC" },
        interfaces: [
          {
            url: "https://example.com/agent",
            protocolBinding: "HTTP_JSON",
          },
        ],
      },
    });
    const targetService = yield* ensureService({
      serviceId: "alchagregtgt",
      displayName: "alchemy-agentregistry-target",
      body: {
        endpointSpec: { type: "NO_SPEC" },
        interfaces: [
          {
            url: "https://example.com/endpoint",
            protocolBinding: "HTTP_JSON",
          },
        ],
      },
    });
    const sourceIdentifier = yield* waitForIdentifier(
      sourceService.name ?? `${parent}/services/alchagregsrc`,
    );
    const targetIdentifier = yield* waitForIdentifier(
      targetService.name ?? `${parent}/services/alchagregtgt`,
    );
    return {
      sourceService,
      targetService,
      sourceIdentifier,
      targetIdentifier,
    };
  });

test.provider.skipIf(runLifecycle)(
  "getProjectsLocationsBindings without Agent Registry enabled fails with ServiceDisabled",
  (stack) =>
    Effect.gen(function* () {
      const parent = yield* currentParent;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        registry.getProjectsLocationsBindings({
          name: `${parent}/bindings/alchemy-missing-binding`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:agentregistry", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a binding",
  (stack) =>
    Effect.gen(function* () {
      const parent = yield* currentParent;
      yield* stack.destroy();

      const {
        sourceService,
        targetService,
        sourceIdentifier,
        targetIdentifier,
      } = yield* ensureFixtures();
      expect(sourceIdentifier).toEqual(expect.any(String));
      expect(targetIdentifier).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AgentRegistry.Binding("Orchestrator", {
            location,
            displayName: "orchestrator tools",
            description: "routes the orchestrator",
            sourceIdentifier: sourceIdentifier!,
            targetIdentifier: targetIdentifier!,
          });
        }),
      );

      expect(created.bindingId).toEqual(expect.any(String));
      expect(created.name).toEqual(`${parent}/bindings/${created.bindingId}`);
      expect(created.location).toEqual(location);
      expect(created.sourceIdentifier).toEqual(sourceIdentifier);
      expect(created.targetIdentifier).toEqual(targetIdentifier);
      expect(created.displayName).toEqual("orchestrator tools");
      expect(created.description).toEqual("routes the orchestrator");

      const fetched = yield* registry.getProjectsLocationsBindings({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.source?.identifier).toEqual(sourceIdentifier);
      expect(fetched.target?.identifier).toEqual(targetIdentifier);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("routes the orchestrator");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AgentRegistry.Binding("Orchestrator", {
            location,
            displayName: "orchestrator tools v2",
            description: "updated routing",
            sourceIdentifier: sourceIdentifier!,
            targetIdentifier: targetIdentifier!,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.bindingId).toEqual(created.bindingId);
      expect(updated.displayName).toEqual("orchestrator tools v2");
      expect(updated.description).toEqual("updated routing");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");

      yield* deleteService(sourceService.name ?? "");
      yield* deleteService(targetService.name ?? "");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:agentregistry", "live"],
    timeout: 90_000,
  },
);
