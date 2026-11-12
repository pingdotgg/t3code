import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionProfile,
  BearerConnectionTarget,
  entryWithRoutes,
  presentConnectionState,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { projectEnvironmentConnectionSummary } from "@t3tools/client-runtime/state/presentation";
import { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { splitEnvironmentSections } from "./environmentSections";

function connectedEnvironment(
  input: Omit<Partial<ConnectedEnvironmentSummary>, "environmentId"> & {
    readonly environmentId: string;
    readonly isRelayManaged: boolean;
  },
): ConnectedEnvironmentSummary {
  return {
    environmentId: EnvironmentId.make(input.environmentId),
    environmentLabel: input.environmentLabel ?? input.environmentId,
    displayUrl: input.displayUrl ?? `https://${input.environmentId}.example.test/`,
    isRelayManaged: input.isRelayManaged,
    isEnabled: input.isEnabled ?? true,
    connectionState: input.connectionState ?? "connected",
    connectionError: input.connectionError ?? null,
    connectionErrorTraceId: input.connectionErrorTraceId ?? null,
  };
}

function cloudEnvironment(environmentId: string): RelayClientEnvironmentRecord {
  return {
    environmentId: EnvironmentId.make(environmentId),
    label: environmentId,
    endpoint: {
      httpBaseUrl: `https://${environmentId}.cloud.example.test/`,
      wsBaseUrl: `wss://${environmentId}.cloud.example.test/ws`,
      providerKind: "cloudflare_tunnel",
    },
    linkedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("mobile environment settings sections", () => {
  it("keeps a LAN-paired environment local after T3 Connect is added to it", () => {
    const environmentId = EnvironmentId.make("environment-mini");
    const relay = {
      target: new RelayConnectionTarget({ environmentId, label: "Mac mini" }),
      profile: Option.none(),
    };
    const paired = {
      target: new BearerConnectionTarget({ environmentId, label: "Mac mini", connectionId: "lan" }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId: "lan",
          environmentId,
          label: "Mac mini",
          httpBaseUrl: "http://192.168.1.106:3773/",
          wsBaseUrl: "ws://192.168.1.106:3773/",
        }),
      ),
    };
    const saved = projectEnvironmentConnectionSummary(environmentId, {
      entry: entryWithRoutes({ ...relay, enabled: true }, [paired, relay]),
      connection: presentConnectionState(AVAILABLE_CONNECTION_STATE),
      serverConfig: null,
    });

    const sections = splitEnvironmentSections({
      connectedEnvironments: [saved],
      cloudEnvironments: [cloudEnvironment("environment-mini")],
    });

    expect(sections.localEnvironments).toEqual([saved]);
    expect(sections.connectedCloudEnvironments).toEqual([]);
    expect(sections.availableCloudEnvironments).toEqual([]);
  });

  it("keeps saved relay-managed connections under T3 Connect", () => {
    const local = connectedEnvironment({
      environmentId: "environment-local",
      isRelayManaged: false,
    });
    const cloud = connectedEnvironment({
      environmentId: "environment-cloud",
      isRelayManaged: true,
    });

    const sections = splitEnvironmentSections({
      connectedEnvironments: [cloud, local],
      cloudEnvironments: [
        cloudEnvironment("environment-cloud"),
        cloudEnvironment("environment-new"),
      ],
    });

    expect(sections.localEnvironments).toEqual([local]);
    expect(sections.connectedCloudEnvironments).toEqual([cloud]);
    expect(
      sections.availableCloudEnvironments.map((environment) => environment.environmentId),
    ).toEqual([EnvironmentId.make("environment-new")]);
  });

  it("keeps saved relay-managed connections visible when cloud listing is unavailable", () => {
    const cloud = connectedEnvironment({
      environmentId: "environment-cloud",
      isRelayManaged: true,
      connectionState: "reconnecting",
      connectionError: "Environment did not respond before the connection timeout.",
    });

    const sections = splitEnvironmentSections({
      connectedEnvironments: [cloud],
      cloudEnvironments: null,
    });

    expect(sections.localEnvironments).toEqual([]);
    expect(sections.connectedCloudEnvironments).toEqual([cloud]);
    expect(sections.availableCloudEnvironments).toEqual([]);
  });

  it("still offers a cloud environment saved directly as a local backend", () => {
    const local = connectedEnvironment({
      environmentId: "environment-cloud",
      isRelayManaged: false,
    });

    const sections = splitEnvironmentSections({
      connectedEnvironments: [local],
      cloudEnvironments: [cloudEnvironment("environment-cloud")],
    });

    expect(sections.localEnvironments).toEqual([local]);
    expect(sections.connectedCloudEnvironments).toEqual([]);
    expect(
      sections.availableCloudEnvironments.map((environment) => environment.environmentId),
    ).toEqual([EnvironmentId.make("environment-cloud")]);
  });
});
