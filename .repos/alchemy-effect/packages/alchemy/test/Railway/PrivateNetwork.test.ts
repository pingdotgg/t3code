import * as railway from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import { noopSession } from "@/Report";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { suitePartition } from "./suiteProject.ts";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const NetworkConfig = Schema.Struct({
  privateNetworkDisabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  services: Schema.optional(
    Schema.NullOr(
      Schema.Record(
        Schema.String,
        Schema.NullOr(
          Schema.Struct({
            networking: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  privateNetworkEndpoint: Schema.optional(
                    Schema.NullOr(Schema.String),
                  ),
                  serviceDomains: Schema.optional(
                    Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
                  ),
                }),
              ),
            ),
          }),
        ),
      ),
    ),
  ),
});

const readConfig = Effect.fn(function* (environmentId: string) {
  const environment = yield* railway.environment(
    { id: environmentId },
    { config: { where: { decryptVariables: false } }, configEtag: true },
  );
  return {
    config: yield* Schema.decodeUnknownEffect(NetworkConfig)(
      environment.config,
    ),
    etag: environment.configEtag,
  };
});

const lifecycle = (id: string) => ({
  id,
  fqn: id,
  instanceId: id,
  bindings: [],
  session: { ...noopSession, note: () => Effect.void },
});

const networkStack = Effect.gen(function* () {
  const { project, environment } = yield* suitePartition;
  const network = yield* Railway.PrivateNetwork("Mesh", { environment });
  return { project, environment, network };
});

const readEndpoint = (input: {
  environmentId: string;
  privateNetworkId: string;
  serviceId: string;
}) =>
  railway
    .privateNetworkEndpoint(input, {
      publicId: true,
      dnsName: true,
      deletedAt: true,
      syncStatus: true,
    })
    .pipe(
      railway.catchTags("RailwayNotFound", () => Effect.succeed(null)),
      Effect.map((endpoint) =>
        endpoint?.deletedAt == null &&
        endpoint?.syncStatus !== "DELETED" &&
        endpoint?.syncStatus !== "DELETING"
          ? endpoint
          : null,
      ),
    );

const waitForEndpoint = (
  input: Parameters<typeof readEndpoint>[0],
  dnsName?: string,
) =>
  readEndpoint(input).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      times: 8,
      until: (endpoint) =>
        endpoint != null &&
        (dnsName === undefined || endpoint.dnsName === dnsName),
    }),
    Effect.tap((endpoint) =>
      Effect.sync(() => {
        expect(endpoint).not.toBeNull();
        if (dnsName !== undefined) expect(endpoint?.dnsName).toBe(dnsName);
      }),
    ),
  );

const setPrefix = (
  environmentId: string,
  serviceId: string,
  prefix: string | null,
) =>
  railway.environmentPatchCommit({
    environmentId,
    patch: {
      services: {
        [serviceId]: { networking: { privateNetworkEndpoint: prefix } },
      },
    },
  });

test.provider(
  "private network enables the environment and restores its previous disabled flag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const partition = yield* stack.deploy(suitePartition);
      const environmentId = partition.environment.environmentId;
      const service = yield* Effect.acquireRelease(
        railway.createService(
          {
            input: {
              projectId: partition.project.projectId,
              environmentId,
              name: "private-network-disable-fixture",
              source: { image: "nginx:alpine" },
            },
          },
          { id: true },
        ),
        (service) =>
          railway.deleteService({ id: service.id }).pipe(
            railway.catchTags("RailwayNotFound", () => Effect.void),
            Effect.orDie,
          ),
      );
      const [platformNetwork] = yield* railway.privateNetworks(
        { environmentId },
        { publicId: true },
      );
      yield* waitForEndpoint({
        environmentId,
        privateNetworkId: platformNetwork!.publicId,
        serviceId: service.id,
      });
      const disablePatch = yield* railway.environmentPatchCommit({
        environmentId,
        patch: { privateNetworkDisabled: true },
      });
      yield* Effect.logInfo("Private-network disable commit", { disablePatch });
      const disabled = yield* readConfig(environmentId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          times: 8,
          until: ({ config }) => config.privateNetworkDisabled === true,
        }),
      );
      yield* Effect.logInfo("Private-network disabled state", {
        privateNetworkDisabled: disabled.config.privateNetworkDisabled,
        patches: yield* railway.environmentPatches(
          { environmentId, first: 5 },
          { edges: { node: { status: true, lastAppliedError: true } } },
        ),
        networks: yield* railway.privateNetworks(
          { environmentId },
          { name: true, publicId: true, deletedAt: true },
        ),
      });
      expect(disabled.config.privateNetworkDisabled).toBe(true);

      const provider = yield* Provider.findProvider(Railway.PrivateNetwork);
      for (const name of ["backend", "legacy-network"]) {
        const rejected = yield* provider
          .reconcile({
            ...lifecycle("UnsupportedMesh"),
            news: { environment: partition.environment, name },
            olds: undefined,
            output: undefined,
          })
          .pipe(Effect.result);
        expect(rejected).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "Railway.PrivateNetworkNameUnsupported", name },
        });
      }
      expect((yield* readConfig(environmentId)).etag).toBe(disabled.etag);

      const created = yield* stack.deploy(networkStack);
      expect(created.network.name).toBe("railway");
      expect(created.network.environmentId).toBe(environmentId);
      expect(created.network.projectId).toBe(partition.project.projectId);
      expect(created.network.previousPrivateNetworkDisabled).toBe(true);
      const enabled = yield* readConfig(environmentId);
      expect(enabled.config.privateNetworkDisabled).toBe(false);
      const networks = yield* railway.privateNetworks(
        { environmentId },
        { publicId: true, name: true, dnsName: true, deletedAt: true },
      );
      expect(
        networks.find(
          (network) =>
            network.publicId === created.network.publicId &&
            network.deletedAt == null,
        ),
      ).toMatchObject({ name: "railway", dnsName: created.network.dnsName });

      const props = { environment: partition.environment };
      const refreshed = yield* provider.read!({
        ...lifecycle("Mesh"),
        olds: props,
        output: created.network,
      });
      expect(refreshed?.previousPrivateNetworkDisabled).toBe(true);
      const repeated = yield* stack.deploy(networkStack);
      expect(repeated.network.publicId).toBe(created.network.publicId);
      expect(repeated.network.previousPrivateNetworkDisabled).toBe(true);
      expect((yield* readConfig(environmentId)).etag).toBe(enabled.etag);

      // Legacy state cannot establish what the environment used to contain.
      const { previousPrivateNetworkDisabled: _, ...legacy } = repeated.network;
      yield* provider.delete({
        ...lifecycle("Mesh"),
        olds: props,
        output: legacy,
      });
      expect((yield* readConfig(environmentId)).etag).toBe(enabled.etag);
      expect(
        (yield* readConfig(environmentId)).config.privateNetworkDisabled,
      ).toBe(false);

      const retained = yield* stack.deploy(suitePartition);
      expect(retained.environment.environmentId).toBe(environmentId);
      const restored = yield* readConfig(environmentId);
      expect(restored.config.privateNetworkDisabled).toBe(true);
      for (let attempt = 0; attempt < 2; attempt++) {
        yield* provider.delete({
          ...lifecycle("Mesh"),
          olds: props,
          output: repeated.network,
        });
      }
      expect((yield* readConfig(environmentId)).etag).toBe(restored.etag);
    }).pipe(
      Effect.scoped,
      Effect.ensuring(stack.destroy().pipe(Effect.orDie)),
      logLevel,
    ),
  { timeout: 120_000 },
);

test.provider(
  "private endpoint updates platform DNS and restores only its own changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const base = yield* stack.deploy(networkStack);
      const environmentId = base.environment.environmentId;

      yield* Effect.acquireUseRelease(
        railway.createService(
          {
            input: {
              projectId: base.project.projectId,
              environmentId,
              name: "private-network-fixture",
              source: { image: "nginx:alpine" },
            },
          },
          { id: true, name: true },
        ),
        (service) =>
          Effect.gen(function* () {
            const serviceRef = { serviceId: service.id, name: service.name };
            const input = {
              environmentId,
              privateNetworkId: base.network.publicId,
              serviceId: service.id,
            };
            if ((yield* readEndpoint(input)) === null) {
              yield* railway.serviceInstanceDeploy({
                environmentId,
                serviceId: service.id,
              });
            }
            const platformEndpoint = yield* waitForEndpoint(input);
            const domainKey = yield* Effect.sync(() => crypto.randomUUID());
            yield* railway.environmentPatchCommit({
              environmentId,
              patch: {
                services: {
                  [service.id]: {
                    networking: {
                      privateNetworkEndpoint: "original",
                      serviceDomains: { [domainKey]: {} },
                    },
                  },
                },
              },
            });
            yield* waitForEndpoint(input, "original");
            const baseline = yield* readConfig(environmentId);
            const baselineDomains =
              baseline.config.services?.[service.id]?.networking
                ?.serviceDomains;
            expect(baselineDomains).toBeDefined();
            expect(Object.keys(baselineDomains ?? {}).length).toBeGreaterThan(
              0,
            );

            const deployEndpoint = (name?: string) =>
              stack
                .deploy(
                  Effect.gen(function* () {
                    const partition = yield* networkStack;
                    const endpoint = yield* Railway.PrivateNetworkEndpoint(
                      "ApiDns",
                      {
                        network: partition.network,
                        service: serviceRef,
                        ...(name === undefined ? {} : { name }),
                      },
                    );
                    return { ...partition, endpoint };
                  }),
                )
                .pipe(
                  Effect.tapError(() =>
                    readConfig(environmentId).pipe(
                      Effect.tap(({ config }) =>
                        Effect.logInfo("Endpoint configuration after failure", {
                          requested: name ?? null,
                          observed:
                            config.services?.[service.id]?.networking
                              ?.privateNetworkEndpoint ?? null,
                        }),
                      ),
                    ),
                  ),
                );
            const assertConfig = (prefix: string | null) =>
              Effect.gen(function* () {
                const { config } = yield* readConfig(environmentId);
                const networking = config.services?.[service.id]?.networking;
                expect(networking?.privateNetworkEndpoint ?? null).toBe(prefix);
                expect(networking?.serviceDomains).toEqual(baselineDomains);
                expect(config.privateNetworkDisabled).toBe(
                  baseline.config.privateNetworkDisabled,
                );
              });
            const provider = yield* Provider.findProvider(
              Railway.PrivateNetworkEndpoint,
            );
            const created = yield* deployEndpoint("api");
            expect(created.endpoint.publicId).toBe(platformEndpoint?.publicId);
            expect(created.endpoint.serviceId).toBe(service.id);
            expect(created.endpoint.environmentId).toBe(environmentId);
            expect(created.endpoint.privateNetworkId).toBe(
              base.network.publicId,
            );
            expect(created.endpoint.previousDnsPrefix).toBe("original");
            expect(created.endpoint.dnsName).toBe("api");
            yield* waitForEndpoint(input, created.endpoint.dnsName);
            yield* assertConfig("api");

            const props = {
              network: created.network,
              service: serviceRef,
              name: "api",
            };
            const refreshed = yield* provider.read!({
              ...lifecycle("ApiDns"),
              olds: props,
              output: created.endpoint,
            });
            expect(refreshed?.previousDnsPrefix).toBe("original");
            const repeated = yield* deployEndpoint("api");
            expect(repeated.endpoint.publicId).toBe(created.endpoint.publicId);
            expect(repeated.endpoint.previousDnsPrefix).toBe("original");
            yield* assertConfig("api");

            const beforeLegacyDelete = yield* readConfig(environmentId);
            const { previousDnsPrefix: _, ...legacy } = repeated.endpoint;
            const legacyDeletion = yield* provider
              .delete({
                ...lifecycle("ApiDns"),
                olds: props,
                output: legacy,
              })
              .pipe(Effect.result);
            expect(legacyDeletion).toMatchObject({
              _tag: "Failure",
              failure: {
                _tag: "Railway.PrivateNetworkEndpointRestoreUnavailable",
              },
            });
            expect((yield* readConfig(environmentId)).etag).toBe(
              beforeLegacyDelete.etag,
            );
            yield* assertConfig("api");

            const renamed = yield* deployEndpoint("gateway");
            expect(renamed.endpoint.publicId).toBe(created.endpoint.publicId);
            expect(renamed.endpoint.previousDnsPrefix).toBe("original");
            expect(renamed.endpoint.dnsName).toBe("gateway");
            yield* waitForEndpoint(input, renamed.endpoint.dnsName);
            yield* assertConfig("gateway");

            const reset = yield* deployEndpoint();
            expect(reset.endpoint.publicId).toBe(created.endpoint.publicId);
            expect(reset.endpoint.previousDnsPrefix).toBe("original");
            expect(reset.endpoint.dnsName).toBe(service.name);
            yield* waitForEndpoint(input, reset.endpoint.dnsName);
            yield* assertConfig(null);

            const retained = yield* stack.deploy(networkStack);
            expect(retained.environment.environmentId).toBe(environmentId);
            expect(retained.network.publicId).toBe(base.network.publicId);
            yield* assertConfig("original");
            const restored = yield* waitForEndpoint(input, "original");
            expect(restored?.publicId).toBe(created.endpoint.publicId);

            const afterRestore = yield* readConfig(environmentId);
            for (let attempt = 0; attempt < 2; attempt++) {
              yield* provider.delete({
                ...lifecycle("ApiDns"),
                olds: { network: reset.network, service: serviceRef },
                output: reset.endpoint,
              });
            }
            expect((yield* readConfig(environmentId)).etag).toBe(
              afterRestore.etag,
            );
            yield* assertConfig("original");

            const managedAgain = yield* deployEndpoint("api");
            expect(managedAgain.endpoint.previousDnsPrefix).toBe("original");
            yield* setPrefix(environmentId, service.id, "external");
            yield* waitForEndpoint(input, "external");
            yield* stack.deploy(networkStack);
            yield* assertConfig("external");
            const external = yield* waitForEndpoint(input, "external");
            expect(external?.publicId).toBe(created.endpoint.publicId);
          }),
        (service) =>
          railway.deleteService({ id: service.id }).pipe(
            railway.catchTags("RailwayNotFound", () => Effect.void),
            Effect.orDie,
          ),
      );
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)), logLevel),
  { timeout: 120_000 },
);
