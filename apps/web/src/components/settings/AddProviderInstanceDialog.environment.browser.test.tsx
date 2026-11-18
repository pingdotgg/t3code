import { EnvironmentId, ProviderDriverKind, type AcpRegistrySearchAgent } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const actions = vi.hoisted(() => ({
  toast: vi.fn(),
  onOpenChange: vi.fn(),
  canManageProviders: true,
  supportsInference: false,
  enableInference: vi.fn(),
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
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() =>
    new Map([
      [
        remoteEnvironmentId,
        { environment: { capabilities: { inferenceProxy: actions.supportsInference } } },
      ],
    ])) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      inferenceProxy: {
        ...actual.serverEnvironment.inferenceProxy,
        canConnect: () => Atom.make(actions.canManageProviders),
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomCommand: ((command: Parameters<typeof actual.useAtomCommand>[0], options?: string) => {
      const invoke = actual.useAtomCommand(command, options);
      return command.label === "inference:enable-routing" ? actions.enableInference : invoke;
    }) as never,
  };
});
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: actions.toast } };
});
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
    autoOpenBrowser?: boolean;
    onFinish: () => void;
  }) => (
    <section aria-label="Sign-in step">
      {props.environmentId}/{props.instanceId}
      {props.autoOpenBrowser ? " opens the browser" : null}
      <button type="button" onClick={props.onFinish}>
        Finish sign-in
      </button>
    </section>
  ),
}));
vi.mock(import("./CodexSetupSection"), async (original) => ({
  ...(await original()),
  AddManagedCodexAccountDialog: ((props: { environmentId: string }) => (
    <section aria-label="ChatGPT sharing">{props.environmentId}</section>
  )) as never,
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
const queryButton = (label: string) =>
  [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
function button(label: string) {
  const found = queryButton(label);
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}
const click = (label: string) => act(async () => button(label).click());
// Connection methods are named by their aria-label, which also carries the description.
const queryRadio = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((element) =>
    (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().startsWith(name),
  );
function radio(name: string) {
  const found = queryRadio(name);
  expect(found, `radio ${name}`).toBeDefined();
  return found!;
}
const choose = (name: string) => act(async () => radio(name).click());
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

async function useExistingCodexCli() {
  await click("Next");
  await choose("Use existing Codex CLI");
  await click("Continue");
}

async function prepareCodexInstance() {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(dialog()));
  await useExistingCodexCli();
  await type("#add-provider-label", "Work");
  await click("Next");
  stack.move();
  return screen;
}

function setup() {
  actions.canManageProviders = true;
  actions.supportsInference = false;
  actions.enableInference.mockReset();
  actions.toast.mockReset();
  actions.onOpenChange.mockReset();
  settingsHooks.read.mockReset().mockReturnValue({ providerInstances: {} });
  settingsHooks.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  settingsHooks.useMutation.mockReset().mockReturnValue(settingsHooks.mutate);
}

describe("AddProviderInstanceDialog environment routing", () => {
  it("routes the default provider and opens the selected host's accounts before settings update", async () => {
    setup();
    actions.supportsInference = true;
    actions.enableInference.mockResolvedValue(
      AsyncResult.success({ environmentId: EnvironmentId.make("studio"), label: "Studio" }),
    );
    await using _screen = await render(dialog());
    await choose("Codex");
    await click("Next");
    await choose("Use inference accounts");
    await click("Continue");
    expect(actions.enableInference).toHaveBeenCalledExactlyOnceWith({
      consumer: { environmentId: remoteEnvironmentId, label: "Remote device" },
      driver: "codex",
      environments: expect.any(Array),
    });
    expect(document.body.textContent).toContain("Using Studio for inference.");
    expect(settingsHooks.mutate).not.toHaveBeenCalled();
  });

  it.each([
    { driver: "codex", label: "Codex" },
    { driver: "opencode", label: "OpenCode" },
    { driver: "pi", label: "Pi" },
  ])(
    "adds a native $label account without replacing configured instances",
    async ({ driver, label }) => {
      setup();
      settingsHooks.read.mockReturnValue({
        providerInstances: {
          [`${driver}_2`]: { driver, enabled: false },
          ...(driver === "codex"
            ? {}
            : {
                [driver]: { driver, config: { inferenceEnabled: true, inferenceHostId: "host" } },
              }),
        },
      });
      await using _screen = await render(dialog());
      if (driver === "codex") {
        await useExistingCodexCli();
      } else {
        if (!queryRadio(label)) await click("Show more");
        await choose(label);
        await click("Next");
      }
      await click("Next");
      await click("Add instance");
      expect(settingsHooks.mutate).toHaveBeenCalledWith({
        operation: "create",
        instanceId: `${driver}_3`,
        instance: {
          driver,
          enabled: true,
          displayName: label,
          ...(driver === "codex" ? { config: { setupMode: "existing" } } : {}),
        },
      });
    },
  );

  it("includes the explicitly added default accent color when creating a provider", async () => {
    setup();
    await using _screen = await render(dialog());
    await click("Show more");
    await click("Use Kilo Code");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Add accent color for Kilo Code"]')!
        .click(),
    );
    await click("Add color");
    await click("Continue to sign-in");

    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "acpRegistry_kilo_code",
      instance: expect.objectContaining({ accentColor: "#2563eb" }),
    });
  });

  it("keeps fx and the ACP Registry under Show more", async () => {
    setup();
    await using _screen = await render(dialog());
    expect(radio("Codex")).toBeDefined();
    expect(queryRadio("fx")).toBeUndefined();
    expect(document.body.textContent).not.toContain("Use Kilo Code");

    await click("Show more");
    button("Use Kilo Code");
    await act(async () => radio("fx")!.click());
    await click("Next");
    await click("Next");
    await click("Add instance");
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "fx",
      instance: { driver: "fx", enabled: true, displayName: "fx" },
    });
  });

  it("awaits an atomic create before closing and retains prepared ACP metadata", async () => {
    setup();
    const mutation = deferred<{ readonly _tag: "Success"; readonly value: unknown }>();
    settingsHooks.mutate.mockReturnValueOnce(mutation.promise);
    await using _screen = await render(dialog());
    await click("Show more");
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

  it("creates a local command in the selected environment without a sign-in step", async () => {
    setup();
    await using _screen = await render(dialog());
    await click("Show more");
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

  it("rejects a queued save after the provider grant is revoked", async () => {
    setup();
    await using screen = await prepareCodexInstance();
    const save = button("Add instance");
    actions.canManageProviders = false;
    // Click before React renders the revoked grant.
    await act(async () => save.click());

    expect(settingsHooks.mutate).not.toHaveBeenCalled();
    expect(actions.toast).not.toHaveBeenCalled();
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    await screen.rerender(dialog());
    expect(button("Add instance").disabled).toBe(true);
  });
});
