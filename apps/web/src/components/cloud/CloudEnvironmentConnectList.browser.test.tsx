import { BearerConnectionTarget } from "@t3tools/client-runtime/connection";
import type { Discovery } from "@t3tools/client-runtime/relay";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const testState = vi.hoisted(() => ({
  discovered: [] as Array<Discovery.RelayDiscoveredEnvironment>,
}));

vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useRelayEnvironmentDiscovery: (() => ({
    environments: new Map(
      testState.discovered.map((environment) => [
        environment.environment.environmentId,
        environment,
      ]),
    ),
    refreshing: false,
    offline: false,
    error: Option.none(),
  })) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => () => Promise.resolve({ _tag: "Success" })) as never,
}));

import { CloudEnvironmentConnectRows } from "./CloudEnvironmentConnectList";

function discovered(
  environmentId: EnvironmentId,
  label: string,
): Discovery.RelayDiscoveredEnvironment {
  return {
    environment: {
      environmentId,
      label,
      endpoint: {
        httpBaseUrl: `https://${environmentId}.relay.test`,
        wsBaseUrl: `wss://${environmentId}.relay.test`,
        providerKind: "t3_relay",
      },
      linkedAt: "2026-10-01T00:00:00.000Z",
    },
    availability: "online",
    status: Option.none(),
    error: Option.none(),
  };
}

describe("CloudEnvironmentConnectRows", () => {
  it("does not offer a T3 Connect route for the desktop's own WSL backend", async () => {
    const primaryEnvironmentId = EnvironmentId.make("primary");
    const wslEnvironmentId = EnvironmentId.make("wsl-ubuntu");
    const laptopEnvironmentId = EnvironmentId.make("laptop");
    testState.discovered = [
      discovered(primaryEnvironmentId, "This PC"),
      discovered(wslEnvironmentId, "Ubuntu (WSL)"),
      discovered(laptopEnvironmentId, "Laptop"),
    ];
    const wslBackend = {
      environmentId: wslEnvironmentId,
      entry: {
        target: new BearerConnectionTarget({
          environmentId: wslEnvironmentId,
          label: "Ubuntu (WSL)",
          connectionId: "local:wsl:Ubuntu",
        }),
      },
      connection: { phase: "connected", error: null, traceId: null },
      relayManaged: false,
      serverConfig: null,
    } as const;
    const laptopOverLan = {
      environmentId: laptopEnvironmentId,
      entry: {
        target: new BearerConnectionTarget({
          environmentId: laptopEnvironmentId,
          label: "Laptop",
          connectionId: "lan-laptop",
        }),
      },
      connection: { phase: "connected", error: null, traceId: null },
      relayManaged: false,
      serverConfig: null,
    } as const;

    await using screen = await render(
      <CloudEnvironmentConnectRows
        primaryEnvironmentId={primaryEnvironmentId}
        savedEnvironments={[wslBackend, laptopOverLan]}
      />,
    );

    await expect.element(screen.getByText("Laptop")).toBeInTheDocument();
    await expect.element(screen.getByText("Ubuntu (WSL)")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Add route" })).toBeInTheDocument();
  });
});
