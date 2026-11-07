import {
  EnvironmentId,
  managedCapabilityDenial,
  type ManagedPolicySummary,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { AuthorizedClientsHeaderAction } from "./AuthorizedClientsSettings";

const localId = EnvironmentId.make("local");
const serviceId = EnvironmentId.make("service");

const state = vi.hoisted(() => ({
  primaryEnvironmentId: null as string | null,
  policies: new Map<string, unknown>(),
  requestConfirmDialog: vi.fn(async () => false),
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => state.primaryEnvironmentId) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() =>
    new Map(
      [...state.policies].map(([environmentId, managedPolicy]) => [
        environmentId,
        { managedPolicy },
      ]),
    )) as never,
}));
vi.mock(import("../../confirmDialog"), async (original) => ({
  ...(await original()),
  requestConfirmDialog: state.requestConfirmDialog,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));

const remoteClientsOff: ManagedPolicySummary = {
  organization: "Example Corp",
  lockedSettings: [],
  limits: { clients: ["desktop"] },
};

function setup(policies: ReadonlyArray<readonly [EnvironmentId, ManagedPolicySummary]>) {
  state.primaryEnvironmentId = localId;
  state.policies = new Map(policies);
  state.requestConfirmDialog.mockReset().mockResolvedValue(false);
}

const renderHeader = (environmentId: EnvironmentId, onRevokeOtherClients = () => {}) =>
  render(
    <AuthorizedClientsHeaderAction
      environmentId={environmentId}
      onPairingLinkCreated={() => {}}
      clientSessions={null}
      isRevokingOtherClients={false}
      onRevokeOtherClients={onRevokeOtherClients}
      delegatableScopes={[]}
    />,
  );

describe("AuthorizedClientsHeaderAction", () => {
  const denial = managedCapabilityDenial(remoteClientsOff, "remoteClients")!;

  it("follows the selected service's policy, not the primary's", async () => {
    setup([[serviceId, remoteClientsOff]]);
    await using screen = await renderHeader(serviceId);

    await expect.element(screen.getByRole("group", { name: denial })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Create link" })).toBeDisabled();
  });

  it("leaves pairing open on an unmanaged service when the primary is managed", async () => {
    setup([[localId, remoteClientsOff]]);
    await using screen = await renderHeader(serviceId);

    await expect.element(screen.getByRole("button", { name: "Create link" })).toBeEnabled();
    expect(screen.getByRole("group", { name: denial }).query()).toBeNull();
  });

  it.each([
    { confirmed: false, revokes: 0 },
    { confirmed: true, revokes: 1 },
  ])(
    "revokes other clients only after confirmation ($confirmed)",
    async ({ confirmed, revokes }) => {
      setup([]);
      state.requestConfirmDialog.mockResolvedValue(confirmed);
      const onRevokeOtherClients = vi.fn();
      await using screen = await renderHeader(localId, onRevokeOtherClients);

      await screen.getByRole("button", { name: "Revoke others" }).click();

      await vi.waitFor(() => expect(state.requestConfirmDialog).toHaveBeenCalledOnce());
      await state.requestConfirmDialog.mock.results[0]!.value;
      expect(onRevokeOtherClients).toHaveBeenCalledTimes(revokes);
    },
  );
});
