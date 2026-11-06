import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { EnvironmentId, type OpenShellFleetWorkerStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../config.ts";
import * as PeerEnvironmentRegistry from "../peer/PeerEnvironmentRegistry.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ServerEnvironment from "./ServerEnvironment.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as OpenShellFleetStore from "./OpenShellFleetStore.ts";
import * as OpenShellFleetService from "./OpenShellFleetService.ts";

const { fakeGatewayClient } = vi.hoisted(() => {
  const view = (name: string) => ({
    name,
    sandboxId: `sbx-${name}`,
    phase: "Ready",
    labels: {},
    createdAt: 1_700_000_000_000,
  });
  return {
    fakeGatewayClient: {
      health: async () => {},
      createFromTemplate: async (spec: { name?: string }) => view(spec.name ?? "sbx-x"),
      get: async () => null,
      listAll: async () => [],
      deleteSandbox: async () => "completed" as const,
      waitReady: async (name: string) => view(name),
      exec: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
      setPolicy: async () => {},
      listTemplates: async () => [],
      createTemplate: async (spec: { name?: string }) => ({ name: spec.name ?? "tpl" }),
    },
  };
});

vi.mock("@t3tools/openshell/gatewayClient", () => ({
  connectOpenShellGateway: async () => fakeGatewayClient,
}));

const fleetOnSettings = {
  openshellEnabled: true,
  openshell: { gatewayUrl: "https://gateway.example.test", managingInstance: true },
} as const;

const managingEnvironment = Layer.succeed(
  ServerEnvironment.ServerEnvironment,
  ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-managing")),
    getDescriptor: Effect.die("getDescriptor is unused in this test"),
  }),
);

const layerFleet = (
  settingsContext: Context.Context<ServerSettings.ServerSettingsService>,
  secrets: Layer.Layer<ServerSecretStore.ServerSecretStore>,
) =>
  OpenShellFleetService.layer.pipe(
    Layer.provide(Layer.succeedContext(settingsContext)),
    Layer.provide(secrets),
    Layer.provide(managingEnvironment),
    Layer.provide(Layer.mock(PeerEnvironmentRegistry.PeerEnvironmentRegistry)({})),
    Layer.provide(
      Layer.mock(OpenShellFleetStore.OpenShellFleetStore)({ list: Effect.succeed([]) }),
    ),
    Layer.provide(ServerConfig.layerTest("/tmp/t3-fleet-test-cwd", "/tmp/t3-fleet-test")),
    Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
    Layer.provide(NodeServices.layer),
    Layer.provide(FetchHttpClient.layer),
  );

describe("OpenShellFleetService", () => {
  it.effect("refuses a spawn once OpenShell is disabled after first use", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsContext = yield* Layer.build(ServerSettings.layerTest(fleetOnSettings));
        const settings = Context.get(settingsContext, ServerSettings.ServerSettingsService);
        const fleet = yield* OpenShellFleetService.OpenShellFleetService.pipe(
          Effect.provide(
            layerFleet(
              settingsContext,
              Layer.mock(ServerSecretStore.ServerSecretStore)({ get: () => Effect.succeedNone }),
            ),
          ),
        );

        expect(yield* fleet.listWorkers({})).toEqual([] as OpenShellFleetWorkerStatus[]);

        yield* settings.updateSettings({ openshellEnabled: false });
        const error = yield* fleet
          .spawnWorker({ runtimeModeCeiling: "approval-required", workerClass: "ephemeral" })
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(OpenShellFleetService.OpenShellFleetDisabled);
      }),
    ),
  );

  it.effect("labels an init failure with the calling operation and a stable message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsContext = yield* Layer.build(ServerSettings.layerTest(fleetOnSettings));
        const secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: () =>
            Effect.fail(
              new ServerSecretStore.SecretStoreReadError({
                resource: "openshell-gateway-credential",
                cause: "locked in this test",
              }),
            ),
        });
        const fleetFor = () =>
          OpenShellFleetService.OpenShellFleetService.pipe(
            Effect.provide(layerFleet(settingsContext, secrets)),
          );

        const removeError = yield* fleetFor().pipe(
          Effect.flatMap((fleet) =>
            fleet
              .removeWorker({ targetEnvironmentId: EnvironmentId.make("environment-worker-1") })
              .pipe(Effect.flip),
          ),
        );
        expect(removeError).toMatchObject({
          _tag: "OpenShellFleetOperationFailed",
          operation: "remove",
          message: "The fleet operation failed.",
        });

        const listError = yield* fleetFor().pipe(
          Effect.flatMap((fleet) => fleet.listWorkers({}).pipe(Effect.flip)),
        );
        expect(listError).toMatchObject({
          _tag: "OpenShellFleetOperationFailed",
          operation: "list",
          message: "The fleet operation failed.",
        });
      }),
    ),
  );
});
