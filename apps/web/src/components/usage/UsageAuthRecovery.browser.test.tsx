import { EnvironmentId, ProviderInstanceId, type UsageSource } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ permitted: true, copy: vi.fn() }));

function setup() {
  state.permitted = true;
  state.copy.mockReset();
}

vi.mock(import("../../state/session"), () => ({
  useEnvironmentScope: ((environmentId: string) =>
    environmentId === "remote-mac" && state.permitted) as never,
}));
vi.mock(import("../../state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  const providers = Atom.make([]);
  return { serverEnvironment: { providersValueAtom: () => providers } } as never;
});
vi.mock(
  import("../../hooks/useCopyToClipboard"),
  () => ({ writeTextToClipboard: state.copy }) as never,
);

import { UsageAuthRecovery } from "./UsageAuthRecovery";

const environmentId = EnvironmentId.make("remote-mac");
const instanceId = ProviderInstanceId.make("cursor-work");
const source: UsageSource = {
  fingerprint: {
    hostId: "host",
    provider: "cursor",
    resolvedHomePath: "cursor-account:demo",
    volumeId: "demo",
  },
  status: "partial",
  scannedFiles: 1,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 0,
  message: "Sign in to Cursor again to read account usage.",
  authRecovery: [{ kind: "provider", instanceId }],
};

it("opens account controls on the originating server and instance", async () => {
  setup();
  await using screen = await render(
    <UsageAuthRecovery environmentId={environmentId} label="Remote Mac" source={source} />,
    { router: "/usage" },
  );
  await screen.getByRole("button", { name: "Sign in again" }).click();
  await vi.waitFor(() => {
    expect(screen.router?.state.location.pathname).toBe("/settings/providers");
    expect(screen.router?.state.location.search).toMatchObject({ environmentId, instanceId });
  });
});

it("keeps API-key and CLI recovery distinct and respects provider permissions", async () => {
  setup();
  state.permitted = false;
  await using screen = await render(
    <UsageAuthRecovery environmentId={environmentId} label="Remote Mac" source={source} />,
  );
  await expect.element(screen.getByRole("button", { name: "Sign in again" })).toBeDisabled();
  state.permitted = true;
  await screen.rerender(
    <UsageAuthRecovery
      environmentId={environmentId}
      label="Remote Mac"
      source={{ ...source, authRecovery: [{ kind: "apiKey", instanceId }] }}
    />,
  );
  await expect.element(screen.getByRole("button", { name: "Provider settings" })).toBeEnabled();
  await expect
    .element(screen.getByRole("button", { name: "Sign in again" }))
    .not.toBeInTheDocument();
  await screen.rerender(
    <UsageAuthRecovery
      environmentId={environmentId}
      label="Remote Mac"
      source={{ ...source, authRecovery: [{ kind: "cursorCli" }] }}
    />,
  );
  await expect.element(screen.getByText("Run", { exact: false })).toBeVisible();
  await screen.getByRole("button", { name: "Copy sign-in command" }).click();
  expect(state.copy).toHaveBeenCalledWith("cursor-agent login", "Cursor sign-in command");
});
