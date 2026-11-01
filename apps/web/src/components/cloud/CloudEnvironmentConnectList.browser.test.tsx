import { RegistryContext } from "@effect/atom-react";
import type { Discovery } from "@t3tools/client-runtime/relay";
import { serverUpdateStateAtom } from "@t3tools/client-runtime/state/server";
import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const discovery = vi.hoisted(() => ({
  state: null as Discovery.RelayEnvironmentDiscoveryState | null,
  refresh: vi.fn(),
  register: vi.fn(),
  update: vi.fn(),
}));

vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { relayEnvironmentDiscovery } = await import("~/state/relay");
  const { updateOutdatedServer } = await import("~/state/server");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === relayEnvironmentDiscovery.refresh
        ? discovery.refresh
        : command === updateOutdatedServer
          ? discovery.update
          : discovery.register) as never,
  };
});
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useRelayEnvironmentDiscovery: () => discovery.state!,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  CloudEnvironmentConnectRows,
  type SavedCloudEnvironmentConnection,
} from "./CloudEnvironmentConnectList";

const environmentId = EnvironmentId.make("work-laptop");
const endpoint = {
  httpBaseUrl: "https://relay.example.test",
  wsBaseUrl: "wss://relay.example.test/ws",
  providerKind: "manual" as const,
};

function setup(selfUpdate: boolean, protocol = ORCHESTRATION_PROTOCOL_VERSION - 1) {
  discovery.refresh.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  discovery.register.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  discovery.update.mockReset();
  appAtomRegistry.set(serverUpdateStateAtom(environmentId), { status: "idle" });
  discovery.state = {
    refreshing: false,
    offline: false,
    error: Option.none(),
    environments: new Map([
      [
        environmentId,
        {
          environment: {
            environmentId,
            label: "Work laptop",
            endpoint,
            linkedAt: "2026-09-05T12:00:00.000Z",
          },
          availability: "online",
          error: Option.none(),
          status: Option.some({
            environmentId,
            endpoint,
            status: "online",
            checkedAt: "2026-09-15T00:00:00Z",
            descriptor: {
              environmentId,
              label: "Work laptop",
              platform: { os: "linux", arch: "x64" },
              serverVersion: "0.0.45",
              orchestrationProtocolVersion: protocol,
              capabilities: {
                repositoryIdentity: true,
                ...(selfUpdate ? { serverSelfUpdate: "boot-service" as const } : {}),
              },
            },
          }),
        },
      ],
    ]),
  };
}

const savedOutdated: SavedCloudEnvironmentConnection = {
  environmentId,
  relayManaged: true,
  connection: {
    phase: "unsupported",
    error: "This client requires a newer server.",
    traceId: null,
  },
  entry: { serverUpdateRequired: true },
};

function rows(savedEnvironments: ReadonlyArray<SavedCloudEnvironmentConnection>) {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <CloudEnvironmentConnectRows
        primaryEnvironmentId={null}
        savedEnvironments={savedEnvironments}
        showSavedEnvironments
      />
    </RegistryContext.Provider>
  );
}

describe("outdated T3 Connect servers", () => {
  it("adds a server that can update itself, then offers the update and a retry", async () => {
    setup(true);
    await using screen = await render(rows([]));
    await expect.element(screen.getByText(/Server update required/)).toBeVisible();
    await screen.getByRole("button", { name: "Add" }).click();
    expect(discovery.register).toHaveBeenCalledTimes(1);

    await screen.rerender(rows([savedOutdated]));
    await expect.element(screen.getByRole("button", { name: "Update" })).toBeEnabled();

    await act(() =>
      appAtomRegistry.set(serverUpdateStateAtom(environmentId), {
        fromVersion: "0.0.45",
        targetVersion: "0.0.46",
        status: "failed",
        stage: "resuming",
        message: "The server did not restart.",
      }),
    );
    await expect.element(screen.getByRole("button", { name: "Retry update" })).toBeVisible();
  });

  it("keeps a server that cannot update itself blocked", async () => {
    setup(false);
    await using screen = await render(rows([]));
    await expect.element(screen.getByText(/Client not supported/)).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(discovery.register).not.toHaveBeenCalled();
  });

  it("keeps a saved server's rejection when discovery reports it compatible", async () => {
    setup(false, ORCHESTRATION_PROTOCOL_VERSION);
    await using screen = await render(rows([{ ...savedOutdated, entry: {} }]));
    await expect
      .element(screen.getByRole("button", { name: "Client not supported" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "Update" }).query()).toBeNull();
  });
});
