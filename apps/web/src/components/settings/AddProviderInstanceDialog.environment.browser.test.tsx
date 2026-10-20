import { EnvironmentId, ProviderDriverKind, type AcpRegistrySearchAgent } from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const actions = vi.hoisted(() => ({
  toast: vi.fn(),
  onOpenChange: vi.fn(),
  canManageProviders: true,
}));
const settingsHooks = vi.hoisted(() => ({
  read: vi.fn(() => ({ providerInstances: {} })),
  mutate: vi.fn(),
  useMutation: vi.fn(),
}));
const preparedAgent = vi.hoisted((): AcpRegistrySearchAgent => ({
  id: "kilo",
  name: "Kilo Code",
  version: "4.2.0",
  description: "Kilo ACP agent",
  authors: ["Kilo"],
  license: "Apache-2.0",
  website: null,
  repository: null,
  icon: "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg",
  distribution: "binary",
  integrity: "sha256",
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  squashAtomCommandFailure: () => new Error("The settings update failed."),
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: settingsHooks.read as never,
  usePersistEnvironmentProviderInstanceMutation: settingsHooks.useMutation as never,
}));
vi.mock(import("../../state/session"), async (original) => {
  const hasScope = (environmentId: EnvironmentId, scope: string) =>
    environmentId === "remote-device" && scope === "providers:manage" && actions.canManageProviders;
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: actions.toast } };
});
// The registry search and the sign-in step talk to the environment over RPC; these
// stand-ins expose the choices a user makes there.
vi.mock(import("./AcpRegistrySearchStep"), async (original) => ({
  ...(await original()),
  AcpRegistrySearchStep: ((props: {
    onPrepared: (agent: AcpRegistrySearchAgent) => void;
    onManualConfiguration: () => void;
    onLocalConfiguration: () => void;
  }) => (
    <div>
      <button type="button" onClick={() => props.onPrepared(preparedAgent)}>
        Use Kilo Code
      </button>
      <button type="button" onClick={props.onManualConfiguration}>
        Enter registry agent
      </button>
      <button type="button" onClick={props.onLocalConfiguration}>
        Use local command
      </button>
    </div>
  )) as never,
}));
vi.mock(import("./ProviderWizardAuthenticationStep"), async (original) => ({
  ...(await original()),
  ProviderWizardAuthenticationStep: (props: {
    environmentId: string;
    instanceId: string;
    onFinish: () => void;
  }) => (
    <section aria-label="Sign-in step">
      {props.environmentId}/{props.instanceId}
      <button type="button" onClick={props.onFinish}>
        Finish sign-in
      </button>
    </section>
  ),
}));

import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";

const remoteEnvironmentId = EnvironmentId.make("remote-device");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const dialog = () => (
  <AddProviderInstanceDialog
    open
    environmentId={remoteEnvironmentId}
    environmentLabel="Remote device"
    onOpenChange={actions.onOpenChange}
  />
);
function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}
const click = (label: string) => act(async () => button(label).click());
const input = (selector: string) => {
  const found = document.querySelector<HTMLInputElement>(selector);
  expect(found, selector).not.toBeNull();
  return found!;
};
async function type(selector: string, value: string) {
  await userEvent.fill(input(selector), value);
  await act(async () => input(selector).blur());
}
const signInStep = () => document.querySelector('[aria-label="Sign-in step"]');

async function prepareCodexInstance() {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(dialog()));
  await click("Configure manually");
  await type("#add-provider-label", "Work");
  await click("Next");
  stack.move();
  return screen;
}

function setup() {
  actions.canManageProviders = true;
  actions.toast.mockReset();
  actions.onOpenChange.mockReset();
  settingsHooks.read.mockReset().mockReturnValue({ providerInstances: {} });
  settingsHooks.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  settingsHooks.useMutation.mockReset().mockReturnValue(settingsHooks.mutate);
}

describe("AddProviderInstanceDialog environment routing", () => {
  it("creates a provider with its default identity without typing", async () => {
    setup();
    await using _screen = await render(dialog());
    const grok = [...document.querySelectorAll('[role="radio"]')].find((radio) =>
      radio.textContent?.includes("Grok"),
    ) as HTMLElement;
    await act(async () => grok.click());
    await click("Next");
    await click("Next");
    await click("Add instance");
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "grok",
      instance: { driver: "grok", enabled: true, displayName: "Grok" },
    });
  });

  it("chooses an unused identity for another account without replacing configured instances", async () => {
    setup();
    settingsHooks.read.mockReturnValue({
      providerInstances: { codex_2: { driver: "codex", enabled: false } },
    });
    await using _screen = await render(dialog());
    await click("Configure manually");
    await click("Next");
    await click("Add instance");
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "codex_3",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "Codex",
        config: { setupMode: "existing" },
      },
    });
  });

  it("reads and writes settings through the supplied environment", async () => {
    setup();
    await using _screen = await render(dialog());

    expect(settingsHooks.read).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.useMutation).toHaveBeenCalledWith(remoteEnvironmentId);
  });

  it("awaits an atomic create before closing and retains prepared ACP metadata", async () => {
    setup();
    const mutation = deferred<{ readonly _tag: "Success"; readonly value: unknown }>();
    settingsHooks.mutate.mockReturnValueOnce(mutation.promise);
    await using _screen = await render(dialog());
    await click("Use Kilo Code");

    expect(document.body.textContent).toContain("v4.2.0 · binary");
    await click("Continue to sign-in");
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_kilo_code",
      instance: {
        driver: ProviderDriverKind.make("acpRegistry"),
        enabled: true,
        displayName: "Kilo Code",
        config: {
          agentId: "kilo",
          distribution: "auto",
          registryIconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg",
        },
      },
    });
    expect(signInStep()).toBeNull();

    await act(async () => mutation.resolve({ _tag: "Success", value: {} }));
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    expect(signInStep()?.textContent).toContain("remote-device/acpRegistry_kilo_code");
    expect(settingsHooks.mutate).toHaveBeenCalledTimes(1);
    await click("Finish sign-in");
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("configures a manually entered registry agent from the first provider screen", async () => {
    setup();
    await using _screen = await render(dialog());
    await click("Enter registry agent");
    await type("#add-provider-acpRegistry-manual-agentId", "devin");
    await click("Next");
    await click("Continue to sign-in");
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_custom",
      instance: {
        driver: "acpRegistry",
        enabled: true,
        config: { agentId: "devin" },
      },
    });
    expect(signInStep()).not.toBeNull();
  });

  it("adds Command Code on the selected environment with its ACP command and identity", async () => {
    setup();
    await using _screen = await render(dialog());
    await click("Add Command Code");
    expect(input("#add-provider-acpRegistry-manual-commandPath").value).toBe("cmd");
    expect(input('input[aria-label="Argument 1"]').value).toBe("acp");
    await click("Next");
    await click("Add instance");

    expect(settingsHooks.useMutation).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_command_code",
      instance: {
        driver: "acpRegistry",
        enabled: true,
        displayName: "Command Code",
        config: { source: "local", commandPath: "cmd", commandArgs: ["acp"] },
      },
    });
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
    expect(signInStep()).toBeNull();
  });

  it("creates a local command in the selected environment without a sign-in step", async () => {
    setup();
    await using _screen = await render(dialog());
    await click("Use local command");
    await click("Next");
    expect(document.body.textContent).toContain("Executable is required.");
    expect(settingsHooks.mutate).not.toHaveBeenCalled();

    await type("#add-provider-acpRegistry-manual-commandPath", "dsh");
    const commandArgs = ["--profile", "acp", " literal $(value) ; ", ""];
    for (const [index, argument] of commandArgs.entries()) {
      await click("Add argument");
      if (argument) await type(`input[aria-label="Argument ${index + 1}"]`, argument);
    }
    await click("Add variable");
    await type('input[aria-label="Environment variable name 1"]', "DSH_PROFILE");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Mark environment variable DSH_PROFILE as sensitive"]',
        )!
        .click(),
    );
    await type('input[aria-label="Environment variable value 1"]', "work");
    await click("Next");
    await type("#add-provider-label", "Deepseek Harness");
    await click("Add instance");

    expect(settingsHooks.useMutation).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_deepseek_harness",
      instance: {
        driver: "acpRegistry",
        enabled: true,
        displayName: "Deepseek Harness",
        config: { source: "local", commandPath: "dsh", commandArgs },
        environment: [
          expect.objectContaining({ name: "DSH_PROFILE", value: "work", sensitive: false }),
        ],
      },
    });
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
    expect(signInStep()).toBeNull();
  });

  it("keeps the dialog open when the atomic upsert fails", async () => {
    setup();
    settingsHooks.mutate.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("Conflict") });
    await using _screen = await render(dialog());
    await click("Use Kilo Code");
    await click("Continue to sign-in");

    expect(actions.onOpenChange).not.toHaveBeenCalled();
    expect(actions.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Could not add provider instance" }),
    );
    expect(button("Continue to sign-in").disabled).toBe(false);
  });

  it("adds an instance with the selected environment's provider grant alone", async () => {
    setup();
    await using _screen = await prepareCodexInstance();
    await click("Add instance");

    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "codex_work",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "Work",
        config: { setupMode: "existing" },
      },
    });
    expect(actions.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Provider instance added" }),
    );
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("rejects a queued save after the provider grant is revoked", async () => {
    setup();
    await using screen = await prepareCodexInstance();
    const save = button("Add instance");
    actions.canManageProviders = false;
    // The rendered button is still enabled; the click must recheck the live grant.
    await act(async () => save.click());

    expect(settingsHooks.mutate).not.toHaveBeenCalled();
    expect(actions.toast).not.toHaveBeenCalled();
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    await screen.rerender(dialog());
    expect(button("Add instance").disabled).toBe(true);
  });

  it("keeps a denied draft available when the provider grant arrives", async () => {
    setup();
    actions.canManageProviders = false;
    await using screen = await prepareCodexInstance();
    expect(button("Add instance").disabled).toBe(true);
    expect(settingsHooks.mutate).not.toHaveBeenCalled();

    actions.canManageProviders = true;
    await screen.rerender(dialog());
    expect(button("Add instance").disabled).toBe(false);
    await click("Add instance");
    expect(settingsHooks.mutate).toHaveBeenCalledOnce();
    expect(actions.onOpenChange).toHaveBeenCalledWith(false);
  });
});
