import { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useUpdateEverything } from "./useUpdateEverything";

const mocks = vi.hoisted(() => ({
  updateProviders: vi.fn(),
  updateServer: vi.fn(),
  remoteCount: 0,
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    environments: Array.from({ length: mocks.remoteCount }, (_, index) => ({
      environmentId: EnvironmentId.make(`remote-${index}`),
      label: `Remote ${index}`,
      connection: { phase: "connected" },
      serverConfig: {
        environment: {
          serverVersion: "0.0.1",
          capabilities: { serverSelfUpdate: "boot-service" },
        },
        settings: { continueThreadsAfterServerUpdate: false },
      },
    })),
  }),
}));
vi.mock("~/state/session", () => ({
  environmentSessionStatesAtom: () =>
    Atom.make(Array.from({ length: mocks.remoteCount }, () => null)),
}));
vi.mock("~/state/server", () => ({
  environmentUpdateStatesAtom: () =>
    Atom.make(Array.from({ length: mocks.remoteCount }, () => ({ status: "idle" }))),
}));
vi.mock("../ProviderUpdatesAction", () => ({
  useProviderUpdates: () => ({
    machines: Array.from({ length: Math.max(1, mocks.remoteCount) }, (_, index) => ({
      environmentId: EnvironmentId.make(`remote-${index}`),
      label: `Remote ${index}`,
      candidates: [{ driver: ProviderDriverKind.make("claudeAgent") }],
    })),
    updateAll: mocks.updateProviders,
  }),
}));
vi.mock("../ServerUpdateAction", () => ({
  canUpdateServer: () => true,
  useServerUpdate: () => mocks.updateServer,
}));
vi.mock("./updateEverythingRun", () => ({
  clearSavedUpdateEverythingResult: vi.fn(),
  saveUpdateEverythingResult: vi.fn(),
  setUpdateEverythingRun: vi.fn(),
  settleUpdateRunMachine: vi.fn(),
  showUpdateEverythingResult: vi.fn(),
  waitForServerUpdateHandoff: vi.fn(),
  waitForUpdateRestart: vi.fn(),
}));

function setup(remoteCount = 0) {
  mocks.updateProviders.mockReset().mockResolvedValue([]);
  mocks.updateServer.mockReset().mockResolvedValue({ status: "updated" });
  mocks.remoteCount = remoteCount;
}

function UpdatePlan({
  localVersion,
  options,
}: {
  readonly localVersion: string | null;
  readonly options?: Parameters<typeof useUpdateEverything>[1];
}) {
  const plan = useUpdateEverything(localVersion, options);
  return (
    <>
      <output aria-label="Updates available">{String(plan.hasUpdates)}</output>
      <output aria-label="Provider choice available">
        {String(plan.canChooseProviderUpdates)}
      </output>
      <output aria-label="Provider count">{plan.providerCount}</output>
      <output aria-label="Providers">{plan.rows.flatMap((row) => row.providers).join(", ")}</output>
      <output aria-label="App updates">{plan.rows.filter((row) => row.app !== null).length}</output>
      <output aria-label="Restarting machines">{plan.restarts.length}</output>
      <button type="button" onClick={() => void plan.run({})}>
        Update
      </button>
    </>
  );
}

describe("useUpdateEverything provider selection", () => {
  it.each([
    { included: undefined, calls: 1, count: 1, remote: 0, local: true },
    { included: true, calls: 1, count: 1, remote: 0, local: true },
    { included: false, calls: 0, count: 0, remote: 0, local: true },
    { included: false, calls: 0, count: 0, remote: 1, local: false },
    { included: true, calls: 1, count: 3, remote: 3, local: true },
    { included: false, calls: 0, count: 0, remote: 3, local: true },
  ])(
    "selects providers consistently (included=$included, remote=$remote, local=$local)",
    async ({ included, calls, count, remote, local }) => {
      setup(remote);
      await using screen = await render(
        <UpdatePlan
          localVersion={local ? "9.0.0" : null}
          options={included === undefined ? {} : { includeProviderUpdates: included }}
        />,
      );
      expect(screen.getByLabelText("Updates available").element().textContent).toBe("true");
      expect(screen.getByLabelText("Provider choice available").element().textContent).toBe("true");
      expect(screen.getByLabelText("Provider count").element().textContent).toBe(String(count));
      expect(screen.getByLabelText("Providers").element().textContent).toBe(
        Array.from({ length: count }, () => "Claude").join(", "),
      );
      expect(screen.getByLabelText("App updates").element().textContent).toBe(
        String(remote + Number(local)),
      );
      expect(screen.getByLabelText("Restarting machines").element().textContent).toBe(
        String(remote),
      );

      await act(() => screen.container.querySelector<HTMLButtonElement>("button")!.click());
      expect(mocks.updateProviders).toHaveBeenCalledTimes(calls);
      expect(mocks.updateServer).toHaveBeenCalledTimes(remote);
      expect(mocks.updateServer.mock.calls.map(([target]) => target.environmentId)).toEqual(
        Array.from({ length: remote }, (_, index) => `remote-${index}`),
      );
    },
  );

  it("keeps provider-only updates available after excluding them from app updates", async () => {
    setup();
    await using screen = await render(
      <UpdatePlan localVersion={null} options={{ includeProviderUpdates: false }} />,
    );
    expect(screen.getByLabelText("Updates available").element().textContent).toBe("true");
    expect(screen.getByLabelText("Provider choice available").element().textContent).toBe("false");
    expect(screen.getByLabelText("Provider count").element().textContent).toBe("1");

    await act(() => screen.container.querySelector<HTMLButtonElement>("button")!.click());
    expect(mocks.updateProviders).toHaveBeenCalledTimes(1);
  });

  it("excludes providers from track switches regardless of the app-update preference", async () => {
    setup();
    await using screen = await render(
      <UpdatePlan
        localVersion="9.0.0"
        options={{
          channelSwitch: { channel: "latest", version: "9.0.0", databaseMigration: undefined },
        }}
      />,
    );
    expect(screen.getByLabelText("Provider choice available").element().textContent).toBe("false");
    expect(screen.getByLabelText("Provider count").element().textContent).toBe("0");

    await act(() => screen.container.querySelector<HTMLButtonElement>("button")!.click());
    expect(mocks.updateProviders).not.toHaveBeenCalled();
  });
});
