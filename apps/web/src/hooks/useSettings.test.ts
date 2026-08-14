import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createSyncedClientPreferencesSliceAtom,
  createSyncedPlanModeHydrationController,
  createSyncedPlanModeWrite,
  mergeEnvironmentSettings,
  resolveEnvironmentIdentificationMode,
  resolveSyncedPlanModeHydrationAction,
  type SyncedPlanModeHydrationInput,
  useSyncedPlanModeHydrationEffect,
} from "./useSettings";

function createHookTestRoot() {
  const noop = () => {};
  class TestHTMLElement {
    readonly nodeType = 1;
  }
  class TestHtmlIFrameElement extends TestHTMLElement {}
  const document = {
    nodeType: 9,
    addEventListener: noop,
    removeEventListener: noop,
    defaultView: globalThis,
    activeElement: null,
    body: null as unknown,
    documentElement: null as unknown,
  };
  const container = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener: noop,
    removeEventListener: noop,
    firstChild: null,
    lastChild: null,
    parentNode: null,
    textContent: "",
  };
  document.body = container;
  document.documentElement = container;
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLElement", TestHTMLElement);
  vi.stubGlobal("HTMLIFrameElement", TestHtmlIFrameElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return createRoot(container as unknown as Element);
}

describe("synced plan mode", () => {
  it("adopts an environment value over the local cache", () => {
    expect(
      resolveSyncedPlanModeHydrationAction({
        clientHydrated: true,
        clientValue: false,
        serverPreferences: {
          planModeEnabled: true,
          updatedAt: "2026-08-14T12:00:00.000Z",
        },
        seedPending: false,
        now: "2026-08-14T12:01:00.000Z",
      }),
    ).toEqual({
      type: "adopt",
      value: true,
      updatedAt: "2026-08-14T12:00:00.000Z",
    });
  });

  it("seeds a missing environment value once from the local cache", () => {
    expect(
      resolveSyncedPlanModeHydrationAction({
        clientHydrated: true,
        clientValue: true,
        serverPreferences: {
          appearanceMode: "dark",
          updatedAt: "2026-08-14T12:00:00.000Z",
        },
        seedPending: false,
        now: "2026-08-14T11:00:00.000Z",
      }),
    ).toEqual({
      type: "seed",
      value: true,
      updatedAt: "2026-08-14T12:00:00.001Z",
    });
    expect(
      resolveSyncedPlanModeHydrationAction({
        clientHydrated: true,
        clientValue: true,
        serverPreferences: undefined,
        seedPending: true,
        now: "2026-08-14T12:01:00.000Z",
      }),
    ).toEqual({ type: "none" });
  });

  it("writes one stamped value to the local and environment stores", () => {
    expect(
      createSyncedPlanModeWrite({
        value: false,
        serverPreferences: {
          planModeEnabled: true,
          updatedAt: "2026-08-14T12:00:00.000Z",
        },
        now: "2026-08-14T12:01:00.000Z",
      }),
    ).toEqual({
      clientPatch: { planModeEnabled: false },
      request: {
        patch: { planModeEnabled: false },
        updatedAt: "2026-08-14T12:01:00.000Z",
      },
    });
  });

  it("does not re-adopt stale server state while a local write is pending", () => {
    expect(
      resolveSyncedPlanModeHydrationAction({
        clientHydrated: true,
        clientValue: false,
        serverPreferences: {
          planModeEnabled: true,
          updatedAt: "2026-08-14T12:00:00.000Z",
        },
        seedPending: false,
        writePending: {
          value: false,
          updatedAt: "2026-08-14T12:01:00.000Z",
        },
        now: "2026-08-14T12:01:00.000Z",
      }),
    ).toEqual({ type: "none" });
  });

  it("keeps divergent values stable with both environment hydration hooks mounted", async () => {
    const primaryEnvironmentId = EnvironmentId.make("primary");
    const secondaryEnvironmentId = EnvironmentId.make("secondary");
    const controller = createSyncedPlanModeHydrationController();
    const persisted: boolean[] = [];
    let localValue = false;
    const persist = (value: boolean) => {
      if (localValue === value) return;
      localValue = value;
      persisted.push(value);
    };
    const patch = vi.fn(async () =>
      AsyncResult.success({
        planModeEnabled: true,
        updatedAt: "2026-08-14T12:00:00.000Z",
      }),
    );
    const HydrationHook = ({ input }: { input: SyncedPlanModeHydrationInput<never> }) => {
      useSyncedPlanModeHydrationEffect(controller, input);
      return null;
    };
    const root = createHookTestRoot();

    try {
      for (let render = 0; render < 10; render += 1) {
        await act(async () => {
          root.render(
            createElement(
              Fragment,
              null,
              createElement(HydrationHook, {
                input: {
                  environmentId: primaryEnvironmentId,
                  primaryEnvironmentId,
                  clientHydrated: true,
                  clientValue: localValue,
                  live: true,
                  serverPreferences: {
                    planModeEnabled: true,
                    updatedAt: "2026-08-14T12:00:00.000Z",
                  },
                  canPatch: true,
                  now: "2026-08-14T12:01:00.000Z",
                  patch,
                  persist,
                },
              }),
              createElement(HydrationHook, {
                input: {
                  environmentId: secondaryEnvironmentId,
                  primaryEnvironmentId,
                  clientHydrated: true,
                  clientValue: localValue,
                  live: true,
                  serverPreferences: {
                    planModeEnabled: false,
                    updatedAt: "2026-08-14T12:02:00.000Z",
                  },
                  canPatch: true,
                  now: "2026-08-14T12:01:00.000Z",
                  patch,
                  persist,
                },
              }),
            ),
          );
        });
      }

      expect(localValue).toBe(true);
      expect(persisted).toEqual([true]);
      expect(patch).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("settles a pending write from an older canonical ack without re-patching", async () => {
    const primaryEnvironmentId = EnvironmentId.make("primary");
    const controller = createSyncedPlanModeHydrationController();
    let localValue = false;
    const persist = (value: boolean) => {
      localValue = value;
    };
    const canonical = {
      planModeEnabled: false,
      updatedAt: "2026-08-14T12:00:30.000Z",
    } as const;
    const previous = {
      planModeEnabled: true,
      updatedAt: "2026-08-14T12:00:00.000Z",
    } as const;
    const patch = vi.fn(async () => AsyncResult.success(canonical));

    controller.synchronize({
      environmentId: primaryEnvironmentId,
      primaryEnvironmentId,
      clientHydrated: true,
      clientValue: localValue,
      live: true,
      serverPreferences: previous,
      canPatch: true,
      now: "2026-08-14T12:00:01.000Z",
      patch,
      persist,
    });
    persist(false);
    controller.write({
      environmentId: primaryEnvironmentId,
      value: false,
      serverPreferences: previous,
      canPatch: true,
      now: "2099-01-01T00:00:00.000Z",
      patch,
      persist,
    });
    await Promise.resolve();

    controller.synchronize({
      environmentId: primaryEnvironmentId,
      primaryEnvironmentId,
      clientHydrated: true,
      clientValue: localValue,
      live: true,
      serverPreferences: previous,
      canPatch: true,
      now: "2099-01-01T00:00:01.000Z",
      patch,
      persist,
    });
    for (let render = 0; render < 3; render += 1) {
      controller.synchronize({
        environmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        clientHydrated: true,
        clientValue: localValue,
        live: true,
        serverPreferences: canonical,
        canPatch: true,
        now: "2099-01-01T00:00:01.000Z",
        patch,
        persist,
      });
    }
    await Promise.resolve();

    expect(patch).toHaveBeenCalledTimes(1);
    expect(localValue).toBe(false);
  });

  it("does not seed preferences without orchestration operate scope", () => {
    const primaryEnvironmentId = EnvironmentId.make("read-only");
    const controller = createSyncedPlanModeHydrationController();
    const patch = vi.fn(async () =>
      AsyncResult.success({
        planModeEnabled: false,
        updatedAt: "2026-08-14T12:00:00.000Z",
      }),
    );

    for (let render = 0; render < 3; render += 1) {
      controller.synchronize({
        environmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        clientHydrated: true,
        clientValue: false,
        live: true,
        serverPreferences: undefined,
        canPatch: false,
        now: "2026-08-14T12:00:00.000Z",
        patch,
        persist: vi.fn(),
      });
    }
    controller.write({
      environmentId: primaryEnvironmentId,
      value: true,
      serverPreferences: undefined,
      canPatch: false,
      now: "2026-08-14T12:01:00.000Z",
      patch,
      persist: vi.fn(),
    });

    expect(patch).not.toHaveBeenCalled();
  });

  it("keeps the synced preference atom stable across thread-only shell updates", () => {
    const preferences = {
      planModeEnabled: true,
      updatedAt: "2026-08-14T12:00:00.000Z",
    } as const;
    const shellStateAtom = Atom.make<EnvironmentShellState>({
      status: "live",
      error: Option.none(),
      snapshot: Option.some({
        snapshotSequence: 1,
        projects: [],
        threads: [],
        updatedAt: "2026-08-14T12:00:00.000Z",
        syncedClientPreferences: preferences,
      }),
    });
    const sliceAtom = createSyncedClientPreferencesSliceAtom(shellStateAtom);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sliceAtom);
    const first = registry.get(sliceAtom);

    registry.set(shellStateAtom, {
      status: "live",
      error: Option.none(),
      snapshot: Option.some({
        snapshotSequence: 2,
        projects: [],
        threads: [],
        updatedAt: "2026-08-14T12:00:01.000Z",
        syncedClientPreferences: preferences,
      }),
    });

    expect(registry.get(sliceAtom)).toBe(first);
    unmount();
  });
});

describe("resolveEnvironmentIdentificationMode", () => {
  it("keeps identification hidden until client settings hydrate", () => {
    expect(resolveEnvironmentIdentificationMode({ mode: "artwork", settingsHydrated: false })).toBe(
      "none",
    );
    expect(resolveEnvironmentIdentificationMode({ mode: "pill", settingsHydrated: true })).toBe(
      "pill",
    );
  });

  it("uses a pill instead of artwork with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("pill");
  });

  it("respects none with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "none",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("none");
  });

  it("keeps artwork when the palette theme opts into it", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
        paletteThemeAllowsArtwork: true,
      }),
    ).toBe("artwork");
  });
});

describe("mergeEnvironmentSettings", () => {
  it("combines the selected environment's server settings with client preferences", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex_remote")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_remote"),
          model: "gpt-5.4",
        },
      ],
    };

    const settings = mergeEnvironmentSettings(serverSettings, clientSettings);

    expect(settings.providerInstances).toBe(serverSettings.providerInstances);
    expect(settings.favorites).toBe(clientSettings.favorites);
  });

  it("lets the environment's synced plan mode override the local cache", () => {
    const settings = mergeEnvironmentSettings(
      DEFAULT_SERVER_SETTINGS,
      { ...DEFAULT_CLIENT_SETTINGS, planModeEnabled: false },
      { planModeEnabled: true, updatedAt: "2026-08-14T12:00:00.000Z" },
    );

    expect(settings.planModeEnabled).toBe(true);
  });
});
