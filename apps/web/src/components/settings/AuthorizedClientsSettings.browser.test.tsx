import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  managedCapabilityDenial,
  type AuthEnvironmentScope,
  type ManagedPolicySummary,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { toastManager } from "../ui/toast";
import { AuthorizedClientsHeaderAction, PairingClientsList } from "./AuthorizedClientsSettings";

const localId = EnvironmentId.make("local");
const serviceId = EnvironmentId.make("service");

const state = vi.hoisted(() => ({
  primaryEnvironmentId: null as string | null,
  policies: new Map<string, unknown>(),
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
}

const renderHeader = (
  environmentId: EnvironmentId,
  delegatableScopes: ReadonlyArray<AuthEnvironmentScope> = [],
) =>
  render(
    <AuthorizedClientsHeaderAction
      environmentId={environmentId}
      onPairingLinkCreated={() => {}}
      clientSessions={null}
      isRevokingOtherClients={false}
      onRevokeOtherClients={() => {}}
      delegatableScopes={delegatableScopes}
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

  it("resets label and permissions when closed with Cancel", async () => {
    setup([]);
    await using screen = await renderHeader(localId, [
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
      AuthFilesystemReadScope,
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Create link" }));
    const labelInput = page.getByRole("textbox", { name: "Client label (optional)" });
    await expect.element(labelInput).toBeVisible();
    await userEvent.fill(labelInput, "Office tablet");

    const operateTasks = page.getByRole("checkbox", { name: /Operate tasks/ });
    await expect.element(operateTasks).toBeChecked();
    await userEvent.click(operateTasks);
    await expect.element(operateTasks).not.toBeChecked();

    await userEvent.click(page.getByRole("button", { name: "Cancel" }));
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Create link" }));
    await expect.element(labelInput).toHaveValue("");
    await expect.element(operateTasks).toBeChecked();
  });
});

describe("PairingClientsList", () => {
  it("clears failed-copy reveal state when closed with Done", async () => {
    setup([]);
    using _clipboard = vi.spyOn(navigator, "clipboard", "get").mockReturnValue(undefined as never);
    await using screen = await render(
      <PairingClientsList
        servedByEnvironment
        endpointUrl="http://192.0.2.10:3773"
        endpoints={[]}
        defaultEndpointKey={null}
        isLoading={false}
        pairingLinks={[
          {
            id: "link-1",
            scopes: [AuthOrchestrationReadScope],
            subject: "subject-1",
            label: "Tablet",
            createdAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        ]}
        createdPairingCredentials={new Map([["link-1", "TESTCODE0000"]])}
        sharedPairingLinkId="link-1"
        clientSessions={[]}
        revokingPairingLinkId={null}
        revokingClientSessionId={null}
        onRevokePairingLink={() => {}}
        onRevokeClientSession={() => {}}
        canRevoke
      />,
    );
    using _execCommand = vi.spyOn(document, "execCommand").mockReturnValue(false);
    using toast = vi.spyOn(toastManager, "add").mockReturnValue("toast");

    await userEvent.click(screen.getByRole("button", { name: "Copy code only" }));
    await expect.element(page.getByRole("heading", { name: "Pairing code" })).toBeVisible();
    expect(toast).toHaveBeenCalledTimes(1);

    await userEvent.click(page.getByRole("button", { name: "Done" }));
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show link" }));
    await expect.element(page.getByRole("heading", { name: "Pairing link" })).toBeVisible();
  });
});
