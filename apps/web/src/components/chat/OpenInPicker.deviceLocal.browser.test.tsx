import { AuthOrchestrationOperateScope, EnvironmentId, type EditorId } from "@t3tools/contracts";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type ConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render as renderUi, stubGlobal } from "../../../test/render";
import { toastManager } from "../ui/toast";

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const STORAGE_KEY = "t3code:device-local-editor-routes:v1";
const WORKSPACE = "/work/project";

const state = vi.hoisted(() => ({
  run: vi.fn(),
  route: null as unknown as Atom.Writable<unknown>,
}));

vi.mock(import("../../state/session"), async (importOriginal) => {
  const actual = await importOriginal();
  const { Atom: AtomApi } = await import("effect/reactivity");
  const route = AtomApi.make<unknown>(null).pipe(AtomApi.keepAlive);
  state.route = route;
  const prepared = AtomApi.make((get) => {
    const current = get(route) as { readonly target: ConnectionTarget } | null;
    return current === null ? Option.none() : Option.some({ target: current.target });
  });
  return {
    ...actual,
    // A granted host scope proves the server route stays available when the opt-in is off.
    readEnvironmentScope: ((_environmentId: string, scope: string) =>
      scope === AuthOrchestrationOperateScope) as never,
    useEnvironmentScope: (() => true) as never,
    environmentSession: {
      ...actual.environmentSession,
      preparedConnectionValueAtom: () => prepared,
    } as never,
  };
});
vi.mock(import("../../state/presentation"), async (importOriginal) => {
  const actual = await importOriginal();
  const { Atom: AtomApi } = await import("effect/reactivity");
  const presentation = AtomApi.make((get) => {
    const current = get(state.route as Atom.Atom<unknown>) as {
      readonly target: ConnectionTarget;
      readonly remoteOpenTargets?: ReadonlyArray<{ kind: string; host: string }>;
    } | null;
    return current === null
      ? null
      : {
          entry: { target: current.target, profile: Option.none() },
          serverConfig: { remoteOpenTargets: current.remoteOpenTargets },
        };
  });
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      presentationAtom: () => presentation,
    } as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => state.run) as never,
}));
vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironment: (() => ({ label: "Test host" })) as never,
}));

import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { useOpenInPreferredEditor } from "../../editorPreferences";
import { OpenInPicker } from "./OpenInPicker";
import {
  registerOpenFavoriteEditorCommand,
  useOpenFavoriteEditorShortcut,
} from "./OpenInPickerShortcut";

const selected = EnvironmentId.make("selected");

const tunnelRoute = {
  target: new BearerConnectionTarget({
    environmentId: selected,
    label: "VM",
    connectionId: "saved-vm-tunnel",
  }),
};
const otherRoute = {
  target: new BearerConnectionTarget({
    environmentId: selected,
    label: "VM",
    connectionId: "saved-vm-tailscale",
  }),
  remoteOpenTargets: [{ kind: "tailscale", host: "sol.tail1234.ts.net" }],
};
const relayRoute = {
  target: new RelayConnectionTarget({
    environmentId: selected,
    label: "VM",
  }),
};
const loopbackPrimary = {
  target: new PrimaryConnectionTarget({
    environmentId: selected,
    label: "This machine",
    httpBaseUrl: "http://127.0.0.1:45999",
    wsBaseUrl: "ws://127.0.0.1:45999",
  }),
};

type OpenResult = { ok: true } | { ok: false; reason: string };

async function setup({ clientEditors = ["zed", "vscode"] as readonly EditorId[] } = {}) {
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  window.localStorage.clear();
  const openLocalEditor = vi.fn<(input: unknown) => Promise<OpenResult>>(async () => ({
    ok: true,
  }));
  const openExternal = vi.fn(async (_url: string) => true);

  await using stack = new AsyncDisposableStack();
  stack.use(
    stubGlobal("desktopBridge", {
      getEditorClientId: () => CLIENT_ID,
      probeRemoteEditors: async () => clientEditors,
      probeLocalEditors: async () => clientEditors,
      openLocalEditor,
      openExternal,
    }),
  );
  stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux"));
  stack.use({ [Symbol.dispose]: () => window.localStorage.clear() });
  stack.use({ [Symbol.dispose]: registerOpenFavoriteEditorCommand() });
  const toast = vi.spyOn(toastManager, "add").mockReturnValue("toast" as never);
  stack.use(toast);
  const screen = stack.use(await renderUi(null));

  const setRoute = (route: unknown) => act(async () => appAtomRegistry.set(state.route, route));
  const mountPicker = (openInCwd: string | null = WORKSPACE) =>
    act(async () =>
      screen.rerender(
        <AppAtomRegistryProvider>
          <OpenInPicker
            environmentId={selected}
            keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
            availableEditors={["vscode"]}
            openInCwd={openInCwd}
            compact
          />
        </AppAtomRegistryProvider>,
      ),
    );
  const unmountPicker = () => act(async () => screen.rerender(null));
  const openMenu = async () => {
    await userEvent.click(page.getByRole("button", { name: "Choose editor" }));
  };
  const closeMenu = async () => {
    await userEvent.keyboard("{Escape}");
  };
  const primary = () => page.getByRole("button", { name: "Open file in preferred editor" });
  const storedRoutes = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");

  const environment = stack.move();
  return {
    screen,
    toast,
    openLocalEditor,
    openExternal,
    setRoute,
    mountPicker,
    unmountPicker,
    openMenu,
    closeMenu,
    primary,
    storedRoutes,
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

describe("device-local editor opt-in", () => {
  it("offers the opt-in on a non-local route and persists it per client and route", async () => {
    await using fixture = await setup();
    const { setRoute, mountPicker, unmountPicker, openMenu, closeMenu, storedRoutes } = fixture;
    await setRoute(tunnelRoute);
    await mountPicker();
    await openMenu();

    await expect.element(page.getByText("Editor location: Automatic ✓")).toBeVisible();
    // Without an SSH route there is nothing to open, which is why the opt-in is offered here.
    await expect.element(page.getByText("No SSH route to Test host")).toBeVisible();

    await userEvent.click(page.getByText("Editor location: This device"));
    expect(storedRoutes()).toEqual([
      JSON.stringify([
        CLIENT_ID,
        JSON.stringify([selected, "BearerConnectionTarget", "saved-vm-tunnel"]),
      ]),
    ]);
    await openMenu();
    await expect.element(page.getByText("Editor location: This device ✓")).toBeVisible();
    // Editors found on this device by the desktop probe, Zed included, replace the dead end.
    await expect.element(page.getByRole("menuitem", { name: "Zed" })).toBeVisible();
    await closeMenu();

    // A fresh mount (a reload) reads the stored choice back.
    await unmountPicker();
    await mountPicker();
    await openMenu();
    await expect.element(page.getByText("Editor location: This device ✓")).toBeVisible();

    await userEvent.click(page.getByText("Editor location: Automatic"));
    expect(storedRoutes()).toEqual([]);
  });

  it("opens through the desktop bridge and never calls the server or an SSH link", async () => {
    await using fixture = await setup();
    const { setRoute, mountPicker, openMenu, primary, openLocalEditor, openExternal } = fixture;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        JSON.stringify([
          CLIENT_ID,
          JSON.stringify([selected, "BearerConnectionTarget", "saved-vm-tunnel"]),
        ]),
      ]),
    );
    await setRoute(tunnelRoute);
    await mountPicker();

    await openMenu();
    await userEvent.click(page.getByRole("menuitem", { name: "Zed" }));
    await userEvent.click(primary());
    await vi.waitFor(() =>
      expect(openLocalEditor).toHaveBeenCalledWith({ editor: "zed", path: WORKSPACE }),
    );
    expect(state.run).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("follows the active route: another route, loopback primary and relay stay unaffected", async () => {
    await using fixture = await setup();
    const { setRoute, mountPicker, openMenu, closeMenu, primary, openLocalEditor, openExternal } =
      fixture;
    await setRoute(tunnelRoute);
    await mountPicker();
    await openMenu();
    await userEvent.click(page.getByText("Editor location: This device"));
    await openMenu();
    await expect.element(page.getByText("Editor location: This device ✓")).toBeVisible();
    await closeMenu();

    // Same environment over a different route: the opt-in does not carry over.
    await setRoute(otherRoute);
    await openMenu();
    await expect.element(page.getByText("Editor location: Automatic ✓")).toBeVisible();
    await closeMenu();
    await userEvent.click(primary());
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
    expect(openExternal.mock.calls[0]![0]).toContain("sol.tail1234.ts.net");
    expect(openLocalEditor).not.toHaveBeenCalled();

    // Relay is its own route and starts on Automatic.
    await setRoute(relayRoute);
    await openMenu();
    await expect.element(page.getByText("Editor location: Automatic ✓")).toBeVisible();
    await closeMenu();

    // Switching back restores the stored choice.
    await setRoute(tunnelRoute);
    await openMenu();
    await expect.element(page.getByText("Editor location: This device ✓")).toBeVisible();
  });

  it("keeps the default loopback behavior: no opt-in menu, server RPC, no bridge launch", async () => {
    await using fixture = await setup();
    const { setRoute, mountPicker, openMenu, primary, openLocalEditor, openExternal } = fixture;
    await setRoute(loopbackPrimary);
    await mountPicker();
    await userEvent.click(primary());
    await vi.waitFor(() =>
      expect(state.run).toHaveBeenCalledWith({
        environmentId: selected,
        input: { cwd: WORKSPACE, editor: "vscode" },
      }),
    );
    expect(openLocalEditor).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();

    await openMenu();
    await expect.element(page.getByRole("menuitem", { name: /^VS Code/ })).toBeVisible();
    expect(document.body.textContent).not.toContain("Editor location");
  });

  it("reports a refused launch and does not fall back to the server", async () => {
    await using fixture = await setup();
    const { setRoute, mountPicker, primary, openLocalEditor, openExternal, toast } = fixture;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        JSON.stringify([
          CLIENT_ID,
          JSON.stringify([selected, "BearerConnectionTarget", "saved-vm-tunnel"]),
        ]),
      ]),
    );
    await setRoute(tunnelRoute);
    await mountPicker();

    openLocalEditor.mockResolvedValueOnce({ ok: false, reason: "path-missing" });
    await userEvent.click(primary());
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          description: expect.stringContaining("Path does not exist on this device"),
        }),
      ),
    );
    openLocalEditor.mockRejectedValueOnce(new Error("ipc closed"));
    await userEvent.click(primary());
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    expect(state.run).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("routes the favorite-editor shortcut and the preferred-editor hook through the bridge", async () => {
    await using fixture = await setup();
    const { screen, setRoute, openLocalEditor, openExternal } = fixture;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        JSON.stringify([
          CLIENT_ID,
          JSON.stringify([selected, "BearerConnectionTarget", "saved-vm-tunnel"]),
        ]),
      ]),
    );
    await setRoute(tunnelRoute);
    function Harness() {
      useOpenFavoriteEditorShortcut({
        enabled: true,
        environmentId: selected,
        keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
        availableEditors: ["vscode"],
        openInCwd: WORKSPACE,
      });
      const openPreferred = useOpenInPreferredEditor(selected, ["vscode"]);
      return (
        <button type="button" onClick={() => void openPreferred("/work/project/src/main.ts")}>
          Open preferred
        </button>
      );
    }
    await act(async () =>
      screen.rerender(
        <AppAtomRegistryProvider>
          <Harness />
        </AppAtomRegistryProvider>,
      ),
    );

    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "o", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    await vi.waitFor(() => expect(openLocalEditor).toHaveBeenCalledTimes(1));

    await userEvent.click(page.getByRole("button", { name: "Open preferred" }));
    await vi.waitFor(() => expect(openLocalEditor).toHaveBeenCalledTimes(2));
    expect(openLocalEditor).toHaveBeenLastCalledWith({
      editor: expect.any(String),
      path: "/work/project/src/main.ts",
    });
    expect(state.run).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });
});
