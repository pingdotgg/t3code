import { act, render as renderScreen, type Screen } from "../../../test/render";
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  type PluginInstallation,
  PluginInstallationId,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  PLUGIN_MANAGE_ACCESS_REQUIRED,
  type PluginManageAccess,
} from "@t3tools/client-runtime/state/pluginPresentation";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentPresentation } from "../../state/environments";
import type { HeldCall, makeFakePluginEnvironment } from "../../test/fakePluginEnvironment";
const server = vi.hoisted(() => ({
  current: null as ReturnType<typeof makeFakePluginEnvironment> | null,
}));
// Only the transport is fake: the atoms, commands, and registry are the client's own.
vi.mock("../../connection/runtime", async () => {
  const { makeFakePluginEnvironment } = await import("../../test/fakePluginEnvironment");
  const { EnvironmentId: Id } = await import("@t3tools/contracts");
  server.current = makeFakePluginEnvironment({
    environmentId: Id.make("remote"),
    capabilities: { repositoryIdentity: true, plugins: true },
  });
  return { connectionAtomRuntime: server.current.runtime };
});
// Imported by the settings page's other sections, which these tests do not render.
vi.mock("../../environments/primary", () => ({ usePrimarySessionState: () => null }));
vi.mock("../../state/session", async () => {
  const Option = await import("effect/Option");
  const { Atom } = await import("effect/reactivity");
  const sessionStates = Atom.make([]);
  return {
    usePreparedConnection: (): ReturnType<
      typeof import("../../state/session").usePreparedConnection
    > => Option.none(),
    environmentSession: { sessionStateAtom: () => null },
    environmentSessionStatesAtom: () => sessionStates,
    readEnvironmentScope: () => true,
    useEnvironmentSessionState: () => null,
    // Settings rows read settings:write; plugin management reads its own session state above.
    useEnvironmentScope: () => true,
    useEnvironmentsWithScope: () => new Set(),
  };
});
import { pluginEnvironment } from "../../state/plugins";
import { PluginEnvironmentCatalog } from "./PluginsSettings";
const environmentId = EnvironmentId.make("remote");
const environment = {
  environmentId,
  label: "Build box",
  entry: { target: { _tag: "RemoteConnectionTarget" } },
  connection: { phase: "connected" },
  serverConfig: {
    environment: {
      platform: { machine: "server" },
      capabilities: { repositoryIdentity: true, plugins: true },
    },
  },
} as unknown as EnvironmentPresentation;
const DIRECTORY = "/srv/plugins/notifier";
const added = {
  installationId: PluginInstallationId.make("installation-1"),
  generation: 1,
  directory: DIRECTORY,
  manifest: null,
  source: { digest: `sha256:${"a".repeat(64)}`, files: 3, bytes: 2048 },
  problem: null,
  inspectedAt: "2026-10-04T00:00:00.000Z",
  consent: null,
  enabled: false,
} as unknown as PluginInstallation;
let registry: AtomRegistry.AtomRegistry;
const fake = () => server.current!;
const catalogAtom = pluginEnvironment.catalog({ environmentId, input: {} });
/** Resolves once `atom` holds a value `matches` accepts; the registry's own notification is the receipt. */
function until<A>(atom: Atom.Atom<A>, matches: (value: A) => boolean) {
  return act(
    () =>
      new Promise<void>((resolve) => {
        let done = false;
        let cancel: (() => void) | null = null;
        const check = (value: A) => {
          if (done || !matches(value)) return;
          done = true;
          cancel?.();
          resolve();
        };
        cancel = registry.subscribe(atom, check);
        check(registry.get(atom));
        if (done) cancel();
      }),
  );
}
const latestRevision = () => {
  const result = registry.get(catalogAtom);
  if (result._tag !== "Success" || result.value._tag !== "available")
    throw new Error("No catalogue");
  return result.value.revision;
};
const delivered = (installations: ReadonlyArray<PluginInstallation>) =>
  until(
    catalogAtom,
    (result) =>
      result._tag === "Success" &&
      result.value._tag === "available" &&
      result.value.installations === installations,
  );
const elements = (selector: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(selector)].filter(
    (element) => element.textContent?.trim() === text,
  );
const button = (text: string) => {
  const [found] = elements("button", text);
  if (!found) throw new Error(`No button "${text}"`);
  return found as HTMLButtonElement;
};
const field = (label: string) => {
  const [found] = elements("label", label) as Array<HTMLLabelElement>;
  return document.getElementById(found!.htmlFor) as HTMLInputElement;
};
const dialogText = () => document.querySelector("[role=dialog]")?.textContent ?? null;
const statusText = () =>
  [...document.querySelectorAll("[role=status]")].map((element) => element.textContent).join("");
const click = (element: HTMLElement) => act(async () => element.click());
const type = (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const render = (screen: Screen, access: PluginManageAccess) =>
  act(
    async () =>
      await screen.rerender(
        <RegistryContext.Provider value={registry}>
          <PluginEnvironmentCatalog
            environment={environment}
            access={access}
            onRetryAccess={null}
          />
        </RegistryContext.Provider>,
      ),
  );
/** Mounts the list showing `installations`, adds the plugin directory, and holds the add request. */
async function addHeld(
  screen: Screen,
  installations: ReadonlyArray<PluginInstallation>,
): Promise<HeldCall> {
  fake().publish(installations);
  await render(screen, "granted");
  await delivered(installations);
  await click(button("Add plugin"));
  await type(field("Plugin directory"), ` ${DIRECTORY} `);
  await click(button("Add and review"));
  const call = await act(() => fake().next(WS_METHODS.pluginsAdd));
  expect(call.input).toEqual({ directory: DIRECTORY });
  return call;
}
describe("adding a plugin directory", () => {
  it("opens the review of the added plugin", async () => {
    using _setup = await setup();
    await using screen = await renderScreen(null, { router: false });
    const call = await addHeld(screen, []);
    const listed = [added];
    fake().publish(listed);
    await act(async () => call.reply({ installation: added }));
    await delivered(listed);
    expect(dialogText()).toContain(`Approve these exact files to run this plugin on Build box.`);
    expect(dialogText()).toContain(DIRECTORY);
    expect(button("Approve and enable")).toBeTruthy();
  });
  it("ends as removed when the restarted snapshot equals the old one", async () => {
    using _setup = await setup();
    await using screen = await renderScreen(null, { router: false });
    // Added and removed elsewhere before the old subscription reported either.
    const call = await addHeld(screen, []);
    const revision = latestRevision();
    await act(async () => call.reply({ installation: added }));
    // Only the restart the reply starts can deliver this unchanged snapshot again.
    await until(
      catalogAtom,
      (result) =>
        result._tag === "Success" &&
        result.value._tag === "available" &&
        result.value.revision > revision,
    );
    expect(dialogText()).toContain("Plugin removed");
    expect(dialogText()).toContain("This plugin is no longer installed on Build box.");
    expect(dialogText()).not.toContain(DIRECTORY);
  });
});
describe("management access", () => {
  it("keeps the view-only explanation through a re-check of a denied session", async () => {
    using _setup = await setup();
    await using screen = await renderScreen(null, { router: false });
    const listed = [added];
    fake().publish(listed);
    await render(screen, "denied");
    await delivered(listed);
    expect(document.body.textContent).toContain(PLUGIN_MANAGE_ACCESS_REQUIRED);
    expect(button("Add plugin").disabled).toBe(true);
    await render(screen, "pending");
    expect(document.body.textContent).toContain(PLUGIN_MANAGE_ACCESS_REQUIRED);
    expect(statusText()).toBe("Checking access…");
    expect(button("Add plugin").disabled).toBe(true);
    await render(screen, "granted");
    expect(document.body.textContent).not.toContain(PLUGIN_MANAGE_ACCESS_REQUIRED);
    expect(statusText()).toBe("");
    expect(button("Add plugin").disabled).toBe(false);
  });
});

async function setup() {
  fake().reset();
  registry = AtomRegistry.make();
  return {
    [Symbol.dispose]() {
      registry.dispose();
    },
  };
}
