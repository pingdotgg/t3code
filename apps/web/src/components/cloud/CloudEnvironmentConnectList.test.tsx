import { type EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { type Discovery } from "@t3tools/client-runtime/relay";
import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type ServerConfig,
} from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import * as Option from "effect/Option";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  discovery: null as Discovery.RelayEnvironmentDiscoveryState | null,
}));

vi.mock("~/connection/catalog", () => ({
  environmentCatalog: { register: Symbol("register") },
}));

vi.mock("~/state/relay", () => ({
  relayEnvironmentDiscovery: { refresh: Symbol("refresh") },
}));

vi.mock("~/state/environments", () => ({
  useRelayEnvironmentDiscovery: () => testState.discovery,
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

import { CloudEnvironmentConnectRows } from "./CloudEnvironmentConnectList";

const environmentId = EnvironmentId.make("saved-windows-environment");
const descriptor = {
  platform: { os: "windows", arch: "x64" },
} as ExecutionEnvironmentDescriptor;
const serverConfig = { environment: descriptor } as ServerConfig;
const connection: EnvironmentConnectionPresentation = {
  phase: "offline",
  error: null,
  traceId: null,
};
const relayEnvironment: RelayClientEnvironmentRecord = {
  environmentId,
  label: "Saved Windows environment",
  endpoint: {
    httpBaseUrl: "https://saved-windows.example.test",
    wsBaseUrl: "wss://saved-windows.example.test",
    providerKind: "t3_relay",
  },
  linkedAt: "2026-08-08T12:00:00.000Z",
};

describe("CloudEnvironmentConnectRows", () => {
  it("keeps the cached OS glyph when a saved environment's relay is offline", () => {
    testState.discovery = {
      environments: new Map([
        [
          environmentId,
          {
            environment: relayEnvironment,
            availability: "offline",
            status: Option.none(),
            error: Option.none(),
          },
        ],
      ]),
      refreshing: false,
      offline: false,
      error: Option.none(),
    };

    const markup = renderToStaticMarkup(
      <CloudEnvironmentConnectRows
        primaryEnvironmentId={null}
        savedEnvironments={[{ environmentId, connection, serverConfig }]}
        showSavedEnvironments
      />,
    );

    expect(markup).toContain('aria-label="Windows"');
  });
});
