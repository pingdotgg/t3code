import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ClientProviderCaller, ClientProviderEmitEvent } from "@t3tools/contracts";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import {
  applyThemeColorPreview,
  getThemeColorVariable,
  getThemePreviewOwner,
  restoreThemeAfterPreview,
  transferThemePreviewOwner,
  THEME_PREVIEW_ID,
} from "../themePalette";
import { themeStore } from "../hooks/useTheme";
import {
  __setClientSettingsForTests,
  getClientSettings,
  persistClientSettingsPatch,
} from "../hooks/useSettings";
import { toastManager } from "../components/ui/toast";
import { formatInlineContextReference } from "../lib/composerContextReferences";
import { useComposerDraftStore, type ComposerContextInsertionHandler } from "../composerDraftStore";
import {
  createClientProviders,
  createComposerClientProvider,
  createNotificationsClientProvider,
  createPanelsClientProvider,
  createTerminalAppearanceClientProvider,
  createThemeClientProvider,
  type ClientProviderDeps,
} from "./clientProviders";
import { ClientProviderOpError, type ClientProviderInvokeCall } from "./clientProviderTypes";
import {
  configureExtensionCommandEnvironment,
  unconfigureExtensionCommandEnvironment,
  type ExtensionCommandEnvironmentDeps,
} from "./extensionCommandRegistry";
import type { InstalledPackage } from "./installedController";

vi.mock("../components/ThreadTerminalDrawer", () => ({
  terminalThemeFromApp: () => ({
    background: { r: 10, g: 20, b: 30 },
    foreground: { r: 200, g: 201, b: 202 },
    cursor: { r: 1, g: 2, b: 3 },
  }),
}));

const ENV = "env-a";
const INSTALL = "ext.a";
const SURFACE = `${INSTALL}/panel`;
const HASH = "hash-a";

const caller = (overrides?: Partial<ClientProviderCaller>): ClientProviderCaller => ({
  installationId: INSTALL,
  contentHash: HASH,
  installationGeneration: 1,
  ...overrides,
});

const context = (overrides?: { environmentId?: string; projectId?: string }): ViewContext => ({
  client: "web",
  resource: {
    namespace: "t3.extensions",
    id: INSTALL,
    environmentId: overrides?.environmentId ?? ENV,
    projectId: overrides?.projectId ?? "project-a",
    threadId: "thread-a",
  },
});

function installation(
  capabilities: readonly string[],
  overrides?: { id?: string; contentHash?: string },
): InstalledPackage {
  return {
    id: overrides?.id ?? INSTALL,
    contentHash: overrides?.contentHash ?? HASH,
    enabled: true,
    installationGeneration: 1,
    grants: {
      capabilities: [...capabilities],
      projectIds: [ProjectId.make("project-a")],
    },
    package: {
      manifest: {
        id: INSTALL,
        apiVersion: 1,
        version: "1.0.0",
        surfaces: [
          {
            id: SURFACE,
            title: "Panel",
            placements: ["side-panel", "bottom-dock"],
            clients: ["web"],
            scope: "thread",
            capabilities: [],
            stateVersion: 1,
          },
        ],
      },
    },
  } as unknown as InstalledPackage;
}

function makeDeps(
  capabilities: readonly string[],
  emit?: (correlationId: string, event: ClientProviderEmitEvent) => void,
  extraInstallations: readonly InstalledPackage[] = [],
): ClientProviderDeps {
  const installed = installation(capabilities);
  return {
    environmentId: EnvironmentId.make(ENV),
    client: "web",
    emit: emit ?? vi.fn(),
    installations: () => [installed, ...extraInstallations],
  };
}

const signal = new AbortController().signal;

function invokeCall(
  method: string,
  input: unknown,
  overrides?: Partial<ClientProviderInvokeCall>,
): ClientProviderInvokeCall {
  return {
    method,
    input: input as ClientProviderInvokeCall["input"],
    context: context(),
    caller: caller(),
    signal,
    ...overrides,
  };
}

function expectDenied(fn: () => unknown, code = "client-target-denied") {
  try {
    fn();
    expect.unreachable("expected a ClientProviderOpError");
  } catch (error) {
    expect(error).toBeInstanceOf(ClientProviderOpError);
    expect((error as ClientProviderOpError).code).toBe(code);
  }
}

// Minimal DOM surface for theme painting + snapshot reads.
function stubThemeDom() {
  const dataset: Record<string, string> = {};
  const styleProps = new Map<string, string>();
  const classes = new Set<string>();
  const style = {
    setProperty: (key: string, value: string) => void styleProps.set(key, value),
    removeProperty: (key: string) => void styleProps.delete(key),
    backgroundColor: "",
  };
  const documentElement = {
    dataset,
    style,
    classList: {
      toggle: (cls: string, force?: boolean) => {
        const next = force ?? !classes.has(cls);
        if (next) classes.add(cls);
        else classes.delete(cls);
        return next;
      },
      contains: (cls: string) => classes.has(cls),
      add: (cls: string) => classes.add(cls),
      remove: (cls: string) => classes.delete(cls),
    },
  };
  vi.stubGlobal("document", {
    documentElement,
    body: { style: { backgroundColor: "" } },
    head: { append: vi.fn() },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ name: "", setAttribute: vi.fn(), content: "" }),
  });
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (key: string) => styleProps.get(key) ?? "",
    backgroundColor: "",
  }));
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
    matchMedia: () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  return { dataset, styleProps, storage };
}

const THEME_CAPS = ["t3.ui/theme.read", "t3.ui/theme.write"];

beforeEach(() => {
  stubThemeDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  unconfigureExtensionCommandEnvironment(ENV);
  useComposerDraftStore
    .getState()
    .clearDraftThread(scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a")));
});

describe("caller authorization", () => {
  it("rejects unknown installations, stale content hashes, and missing grants", () => {
    const deps = makeDeps(THEME_CAPS);
    const provider = createThemeClientProvider(deps);
    expectDenied(() =>
      provider.invoke(invokeCall("getState", {}, { caller: caller({ installationId: "ext.b" }) })),
    );
    expectDenied(() =>
      provider.invoke(invokeCall("getState", {}, { caller: caller({ contentHash: "other" }) })),
    );
    // Read is granted but write is not.
    const readOnly = createThemeClientProvider(makeDeps(["t3.ui/theme.read"]));
    readOnly.invoke(invokeCall("getState", {}));
    expectDenied(() =>
      readOnly.invoke(
        invokeCall("applyPreference", {
          writer: INSTALL,
          preference: { mode: "session", theme: "ocean" },
        }),
      ),
    );
  });

  it("rejects foreign environment and out-of-scope project contexts", () => {
    const provider = createThemeClientProvider(makeDeps(THEME_CAPS));
    expectDenied(() =>
      provider.invoke(invokeCall("getState", {}, { context: context({ environmentId: "env-b" }) })),
    );
    expectDenied(() =>
      provider.invoke(invokeCall("getState", {}, { context: context({ projectId: "project-b" }) })),
    );
  });
});

describe("theme provider", () => {
  it("reports the stored theme when nothing is painted", () => {
    const provider = createThemeClientProvider(makeDeps(THEME_CAPS));
    const state = provider.invoke(invokeCall("getState", {})) as {
      effectiveTheme: { kind: string };
      sessionOverlay: unknown;
    };
    expect(state.effectiveTheme.kind).toBe("stored");
    expect(state.sessionOverlay).toBeNull();
  });

  it("paints a session overlay owned by the calling installation", () => {
    const provider = createThemeClientProvider(makeDeps(THEME_CAPS));
    const applied = provider.invoke(
      invokeCall("applyPreference", {
        writer: INSTALL,
        preference: { mode: "session", theme: "ocean" },
      }),
    ) as { applied: boolean };
    expect(applied.applied).toBe(true);
    const dataset = document.documentElement.dataset as Record<string, string>;
    expect(dataset.themeId).toBe(THEME_PREVIEW_ID);
    expect(dataset.themePreviewOwner).toBe(INSTALL);
    const state = provider.invoke(invokeCall("getState", {})) as {
      effectiveTheme: { kind: string; writer?: string };
    };
    expect(state.effectiveTheme.kind).toBe("session-overlay");
    expect(state.effectiveTheme.writer).toBe(INSTALL);
  });

  it("refuses to impersonate another installation as the writer", () => {
    const provider = createThemeClientProvider(makeDeps(THEME_CAPS));
    expectDenied(() =>
      provider.invoke(
        invokeCall("applyPreference", {
          writer: "ext.other",
          preference: { mode: "session", theme: "ocean" },
        }),
      ),
    );
  });

  it("yields to a foreign preview instead of clobbering it", () => {
    const provider = createThemeClientProvider(makeDeps(THEME_CAPS));
    // The theme editor owns the painted preview — provider writes must defer.
    applyThemeColorPreview({} as never, "light", "t3.theme-editor");
    const denied = provider.invoke(
      invokeCall("applyPreference", {
        writer: INSTALL,
        preference: { mode: "session", theme: "ocean" },
      }),
    ) as { applied: boolean; reason: string };
    expect(denied).toEqual({ applied: false, reason: "external-preview-active" });
    const state = provider.invoke(invokeCall("getState", {})) as {
      effectiveTheme: { kind: string; writer?: string };
    };
    expect(state.effectiveTheme.kind).toBe("external-preview");
    expect(state.effectiveTheme.writer).toBe("t3.theme-editor");
  });

  it("supersedes a peer installation's overlay — equal peers, last-writer-wins", () => {
    const peer = installation(THEME_CAPS, { id: "ext.peer" });
    const provider = createThemeClientProvider(makeDeps(THEME_CAPS, undefined, [peer]));
    // A peer's overlay owns the paint — it is superseded, not refused. The
    // palette is single-writer, so supersede transfers the owner record to the
    // new writer first, then repaints through the owner gate.
    expect(applyThemeColorPreview({} as never, "light", "ext.peer")).toBe(true);
    expect(getThemePreviewOwner()).toBe("ext.peer");
    const applied = provider.invoke(
      invokeCall("applyPreference", {
        writer: INSTALL,
        preference: { mode: "session", theme: "ocean" },
      }),
    ) as { applied: boolean };
    expect(applied.applied).toBe(true);
    const dataset = document.documentElement.dataset as Record<string, string>;
    expect(dataset.themePreviewOwner).toBe(INSTALL);
    expect(getThemePreviewOwner()).toBe(INSTALL);
    // The displaced peer lost the owner record — its owner-gated cleanup is
    // inert now, so it cannot erase the superseding paint.
    const peerRestore = vi.fn();
    restoreThemeAfterPreview("ext.peer", peerRestore);
    expect(peerRestore).not.toHaveBeenCalled();
    const state = provider.invoke(invokeCall("getState", {})) as {
      effectiveTheme: { kind: string; writer?: string };
    };
    expect(state.effectiveTheme).toEqual({
      kind: "session-overlay",
      theme: "ocean",
      writer: INSTALL,
    });
  });

  it("does not resurrect a superseded overlay once the foreign paint clears", () => {
    const provider = createThemeClientProvider(makeDeps(THEME_CAPS));
    provider.invoke(
      invokeCall("applyPreference", {
        writer: INSTALL,
        preference: { mode: "session", theme: "ocean" },
      }),
    );
    // An editor draft takes the paint through the same owner gate the real
    // editor uses — ownership transfers to the host first, then it repaints.
    // The held overlay record is superseded.
    transferThemePreviewOwner("t3.theme-editor");
    applyThemeColorPreview({} as never, "light", "t3.theme-editor");
    const foreign = provider.invoke(invokeCall("getState", {})) as {
      effectiveTheme: { kind: string };
    };
    expect(foreign.effectiveTheme.kind).toBe("external-preview");
    // The draft clears and the stored theme repaints: no ghost overlay resurfaces.
    themeStore.refreshTheme();
    const state = provider.invoke(invokeCall("getState", {})) as {
      effectiveTheme: { kind: string };
    };
    expect(state.effectiveTheme.kind).toBe("stored");
  });

  it("clears its own overlay and repaints the stored theme", () => {
    const provider = createThemeClientProvider(makeDeps(THEME_CAPS));
    provider.invoke(
      invokeCall("applyPreference", {
        writer: INSTALL,
        preference: { mode: "session", theme: "ocean" },
      }),
    );
    const cleared = provider.invoke(
      invokeCall("applyPreference", {
        writer: INSTALL,
        preference: { mode: "session", clear: true },
      }),
    ) as { applied: boolean };
    expect(cleared.applied).toBe(true);
    const dataset = document.documentElement.dataset as Record<string, string>;
    expect(dataset.themeId).not.toBe(THEME_PREVIEW_ID);
    expect(dataset.themePreviewOwner).toBeUndefined();
  });

  it("persists a stored preference through the theme store", () => {
    const provider = createThemeClientProvider(makeDeps(THEME_CAPS));
    const applied = provider.invoke(
      invokeCall("applyPreference", {
        writer: INSTALL,
        preference: { mode: "persist", theme: "grove" },
      }),
    ) as { applied: boolean; propagatedTo: string };
    expect(applied).toEqual({ applied: true, propagatedTo: "storage-origin" });
    expect(themeStore.getSnapshot().theme).toBe("grove");
  });

  it("resolves palette tokens for an appearance", () => {
    const provider = createThemeClientProvider(makeDeps(THEME_CAPS));
    provider.invoke(
      invokeCall("applyPreference", {
        writer: INSTALL,
        preference: { mode: "persist", theme: "grove" },
      }),
    );
    const resolved = provider.invoke(invokeCall("resolveTokens", { appearance: "light" })) as {
      tokens: Record<string, string>;
      cssVars: Record<string, string>;
    };
    expect(Object.keys(resolved.tokens).length).toBeGreaterThan(0);
    expect(resolved.cssVars.canvas).toContain("--");
    expectDenied(
      () => provider.invoke(invokeCall("resolveTokens", { appearance: "auto" })),
      "provider-rejected",
    );
  });

  it("falls back to live computed tokens for the stock system theme", () => {
    const provider = createThemeClientProvider(makeDeps(THEME_CAPS));
    // Repaint the stock preference so leftover palette vars are stripped,
    // then simulate the stylesheet-resolved roles the app wears.
    provider.invoke(
      invokeCall("applyPreference", {
        writer: INSTALL,
        preference: { mode: "persist", theme: "system" },
      }),
    );
    const { styleProps } = stubThemeDom();
    styleProps.set(getThemeColorVariable("canvas"), "#fcfcfc");
    const resolved = provider.invoke(invokeCall("resolveTokens", {})) as {
      tokens: Record<string, string>;
    };
    expect(resolved.tokens.canvas).toBe("#fcfcfc");
  });

  it("streams a snapshot then data events on overlay changes", () => {
    const provider = createThemeClientProvider(makeDeps(THEME_CAPS));
    const events: ClientProviderEmitEvent[] = [];
    const close = provider.openStream!({
      name: "watchState",
      input: null,
      context: context(),
      caller: caller(),
      emit: (event) => events.push(event),
    });
    expect(events[0]?.type).toBe("snapshot");
    provider.invoke(
      invokeCall("applyPreference", {
        writer: INSTALL,
        preference: { mode: "session", theme: "ocean" },
      }),
    );
    expect(events.some((event) => event.type === "data")).toBe(true);
    if (typeof close === "function") close();
  });
});

describe("notifications provider", () => {
  it("shows a toast, emits action outcomes, and retains ownership", () => {
    const emits: [string, ClientProviderEmitEvent][] = [];
    const provider = createNotificationsClientProvider(
      makeDeps(["t3.ui/notify"], (correlationId, event) => emits.push([correlationId, event])),
    );
    const addSpy = vi.spyOn(toastManager, "add").mockReturnValue("toast-1" as never);
    const closeSpy = vi.spyOn(toastManager, "close").mockImplementation(() => {});
    provider.invoke(
      invokeCall("notify", {
        notification: {
          notificationId: "n-1",
          severity: "info",
          title: "Build done",
          body: "all good",
          actions: [{ id: "open", label: "Open" }],
        },
      }),
    );
    expect(addSpy).toHaveBeenCalledOnce();
    const toastOptions = addSpy.mock.calls[0]![0] as unknown as {
      title: string;
      data?: { additionalActions?: { props: { onClick: () => void } }[] };
    };
    expect(toastOptions.title).toBe("Build done");
    // Action click emits the outcome under the server correlation id.
    toastOptions.data?.additionalActions?.[0]?.props.onClick();
    expect(emits).toEqual([
      ["n-1", { type: "notificationOutcome", outcome: { actionId: "open" } }],
    ]);
    expect(closeSpy).toHaveBeenCalledWith("toast-1");
  });

  it("enforces owner-scoped update and dismiss", () => {
    const emits: [string, ClientProviderEmitEvent][] = [];
    const other = installation(["t3.ui/notify"], { id: "ext.b", contentHash: "hash-b" });
    const provider = createNotificationsClientProvider(
      makeDeps(["t3.ui/notify"], (correlationId, event) => emits.push([correlationId, event]), [
        other,
      ]),
    );
    vi.spyOn(toastManager, "add").mockReturnValue("toast-2" as never);
    const updateSpy = vi.spyOn(toastManager, "update").mockImplementation(() => {});
    const closeSpy = vi.spyOn(toastManager, "close").mockImplementation(() => {});
    provider.invoke(
      invokeCall("notify", {
        notification: { notificationId: "n-2", severity: "info", title: "Hi" },
      }),
    );
    // A different known installation cannot touch the notification.
    const foreign = caller({ installationId: "ext.b", contentHash: "hash-b" });
    expectDenied(
      () => provider.invoke(invokeCall("dismiss", { notificationId: "n-2" }, { caller: foreign })),
      "notification-owner-mismatch",
    );
    // Unknown id expires rather than lying.
    expectDenied(
      () => provider.invoke(invokeCall("dismiss", { notificationId: "n-404" })),
      "notification-expired",
    );
    provider.invoke(invokeCall("update", { notificationId: "n-2", patch: { title: "Updated" } }));
    expect(updateSpy).toHaveBeenCalledWith("toast-2", { title: "Updated" });
    const dismissed = provider.invoke(invokeCall("dismiss", { notificationId: "n-2" })) as {
      dismissed: boolean;
    };
    expect(dismissed.dismissed).toBe(true);
    expect(closeSpy).toHaveBeenCalledWith("toast-2");
    expect(emits.at(-1)).toEqual([
      "n-2",
      { type: "notificationOutcome", outcome: { dismissed: true } },
    ]);
  });

  it("settles a durationMs toast through its own timer, not the toast manager", () => {
    vi.useFakeTimers();
    try {
      const emits: [string, ClientProviderEmitEvent][] = [];
      const provider = createNotificationsClientProvider(
        makeDeps(["t3.ui/notify"], (correlationId, event) => emits.push([correlationId, event])),
      );
      vi.spyOn(toastManager, "add").mockReturnValue("toast-3" as never);
      const closeSpy = vi.spyOn(toastManager, "close").mockImplementation(() => {});
      provider.invoke(
        invokeCall("notify", {
          notification: {
            notificationId: "n-3",
            severity: "info",
            title: "Soon gone",
            durationMs: 4000,
          },
        }),
      );
      vi.advanceTimersByTime(4000);
      // A parked awaitAction can never be stranded by a timed-out toast.
      expect(emits).toEqual([
        ["n-3", { type: "notificationOutcome", outcome: { dismissed: true } }],
      ]);
      expect(closeSpy).toHaveBeenCalledWith("toast-3");
      // Settled notifications expire honestly for later management.
      expectDenied(
        () => provider.invoke(invokeCall("dismiss", { notificationId: "n-3" })),
        "notification-expired",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles the outcome when the manager closes the toast outside data.onClose", () => {
    const emits: [string, ClientProviderEmitEvent][] = [];
    const provider = createNotificationsClientProvider(
      makeDeps(["t3.ui/notify"], (correlationId, event) => emits.push([correlationId, event])),
    );
    const addSpy = vi.spyOn(toastManager, "add").mockReturnValue("toast-x" as never);
    provider.invoke(
      invokeCall("notify", {
        notification: { notificationId: "n-x", severity: "info", title: "Ephemeral" },
      }),
    );
    const toastOptions = addSpy.mock.calls[0]![0] as unknown as {
      timeout: number;
      onClose: () => void;
    };
    // The manager's own 5 s default must never apply — lifetime is owned here.
    expect(toastOptions.timeout).toBe(0);
    // A manager-driven close (auto-dismiss, closeAll, swipe) fires the
    // top-level onClose, which must settle the owned record.
    toastOptions.onClose();
    expect(emits).toEqual([["n-x", { type: "notificationOutcome", outcome: { dismissed: true } }]]);
    // Settle is first-write-wins: a second close emits nothing.
    toastOptions.onClose();
    expect(emits).toHaveLength(1);
    expectDenied(
      () => provider.invoke(invokeCall("dismiss", { notificationId: "n-x" })),
      "notification-expired",
    );
  });

  it("denies targeting outside the invocation scope and honors anchor/dismissible/variant", () => {
    const provider = createNotificationsClientProvider(makeDeps(["t3.ui/notify"]));
    const addSpy = vi.spyOn(toastManager, "add").mockReturnValue("toast-4" as never);
    // threadId naming another thread is denied, not silently ignored.
    expectDenied(() =>
      provider.invoke(
        invokeCall("notify", {
          notification: {
            notificationId: "n-4",
            severity: "info",
            title: "Hi",
            threadId: "thread-b",
          },
        }),
      ),
    );
    expectDenied(() =>
      provider.invoke(
        invokeCall("notify", {
          notification: {
            notificationId: "n-4",
            severity: "info",
            title: "Hi",
            projectId: "project-b",
          },
        }),
      ),
    );
    provider.invoke(
      invokeCall("notify", {
        notification: {
          notificationId: "n-5",
          severity: "warning",
          title: "Careful",
          anchor: "thread",
          threadId: "thread-a",
          dismissible: false,
          actions: [{ id: "revert", label: "Revert", variant: "destructive" }],
        },
      }),
    );
    const toastOptions = addSpy.mock.calls[0]![0] as unknown as {
      data?: {
        dismissible?: boolean;
        threadRef?: unknown;
        additionalActions?: { variant?: string }[];
      };
    };
    expect(toastOptions.data?.dismissible).toBe(false);
    // A thread anchor means the toast is thread-scoped through the native filter.
    expect(toastOptions.data?.threadRef).not.toBeUndefined();
    expect(toastOptions.data?.additionalActions?.[0]?.variant).toBe("destructive");
  });

  it("merges dismissible into toast data on update without dropping callbacks", () => {
    const provider = createNotificationsClientProvider(makeDeps(["t3.ui/notify"]));
    const addSpy = vi.spyOn(toastManager, "add").mockReturnValue("toast-6" as never);
    const updateSpy = vi.spyOn(toastManager, "update").mockImplementation(() => {});
    provider.invoke(
      invokeCall("notify", {
        notification: { notificationId: "n-6", severity: "info", title: "Hi" },
      }),
    );
    provider.invoke(invokeCall("update", { notificationId: "n-6", patch: { dismissible: false } }));
    const patch = updateSpy.mock.calls[0]![1] as { data?: Record<string, unknown> };
    // `data` replaces wholesale on update — the merge must keep onClose alive.
    expect(patch.data?.dismissible).toBe(false);
    expect(typeof patch.data?.onClose).toBe("function");
    expect(addSpy).toHaveBeenCalledOnce();
  });
});

describe("composer provider", () => {
  it("inserts context refs into the real draft store", () => {
    const provider = createComposerClientProvider(makeDeps(["t3.composer/write"]));
    const result = provider.invoke(
      invokeCall("insertContext", {
        threadId: "thread-a",
        refs: [{ path: "src/a.ts", startLine: 2, endLine: 4, excerpt: "const x = 1;" }],
      }),
    ) as { inserted: number };
    expect(result.inserted).toBe(1);
    const state = provider.invoke(invokeCall("getDraftState", { threadId: "thread-a" })) as {
      draft: { contextCounts: { reviewComments: number } } | null;
    };
    expect(state.draft?.contextCounts.reviewComments).toBe(1);
  });

  it("scopes draft access to the caller's thread context", () => {
    const provider = createComposerClientProvider(makeDeps(["t3.composer/write"]));
    expectDenied(() =>
      provider.invoke(
        invokeCall("insertContext", {
          threadId: "thread-b",
          refs: [{ path: "a.ts" }],
        }),
      ),
    );
    expectDenied(() => provider.invoke(invokeCall("getDraftState", { threadId: "thread-b" })));
  });

  it("requires the composer write grant", () => {
    const provider = createComposerClientProvider(makeDeps([]));
    expectDenied(() =>
      provider.invoke(
        invokeCall("insertContext", { threadId: "thread-a", refs: [{ path: "a.ts" }] }),
      ),
    );
  });

  it("attaches a file annotation and returns its id", () => {
    const provider = createComposerClientProvider(makeDeps(["t3.messages/write"]));
    const result = provider.invoke(
      invokeCall("attachAnnotation", {
        threadId: "thread-a",
        annotation: {
          filePath: "src/b.ts",
          startLine: 3,
          endLine: 5,
          body: "rename this",
          excerpt: "let y = 2;",
        },
      }),
    ) as { annotationId: string };
    expect(result.annotationId).toContain(`annotation:${INSTALL}:`);
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a")));
    expect(draft?.reviewComments.some((entry) => entry.id === result.annotationId)).toBe(true);
  });

  it("quotes exactly the excerpt at its real line numbers", () => {
    const provider = createComposerClientProvider(makeDeps(["t3.messages/write"]));
    const excerpt = "line forty\nline forty one\nline forty two";
    const result = provider.invoke(
      invokeCall("attachAnnotation", {
        threadId: "thread-a",
        annotation: {
          filePath: "src/c.ts",
          startLine: 40,
          endLine: 42,
          body: "check this block",
          excerpt,
        },
      }),
    ) as { annotationId: string };
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a")));
    const entry = draft?.reviewComments.find((comment) => comment.id === result.annotationId);
    expect(entry?.diff).toBe(excerpt);
    expect(entry?.rangeLabel).toBe("L40 to L42");
    expect(entry?.sectionTitle).toBe("File comment");
    expect(entry?.text).toBe("check this block");
  });

  it("quotes no code when the annotation carries no excerpt", () => {
    const provider = createComposerClientProvider(makeDeps(["t3.messages/write"]));
    const result = provider.invoke(
      invokeCall("attachAnnotation", {
        threadId: "thread-a",
        annotation: {
          filePath: "src/c.ts",
          startLine: 1,
          endLine: 1,
          body: "what is this file doing?",
        },
      }),
    ) as { annotationId: string };
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a")));
    const entry = draft?.reviewComments.find((comment) => comment.id === result.annotationId);
    // The body is comment text — it must never double as the quoted code.
    expect(entry?.diff).toBe("");
    expect(entry?.text).toBe("what is this file doing?");
  });

  it("insertContext quotes exactly the excerpt at its real line numbers", () => {
    const provider = createComposerClientProvider(makeDeps(["t3.composer/write"]));
    const excerpt = "export const a = 1;\nexport const b = 2;";
    provider.invoke(
      invokeCall("insertContext", {
        threadId: "thread-a",
        refs: [{ path: "src/d.ts", startLine: 10, endLine: 11, excerpt }],
      }),
    );
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a")));
    const entry = draft?.reviewComments.find((comment) => comment.filePath === "src/d.ts");
    expect(entry?.diff).toBe(excerpt);
    expect(entry?.rangeLabel).toBe("L10 to L11");
    // Without an excerpt the path must not be quoted as code.
    provider.invoke(
      invokeCall("insertContext", {
        threadId: "thread-a",
        refs: [{ path: "src/e.ts", startLine: 2, endLine: 3 }],
      }),
    );
    const next = useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a")));
    const bare = next?.reviewComments.find((comment) => comment.filePath === "src/e.ts");
    expect(bare?.diff).toBe("");
  });

  it("insertMention appends byte-exact file links with a leading boundary", () => {
    const provider = createComposerClientProvider(makeDeps(["t3.composer/write"]));
    const ref = scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a"));
    const readPrompt = () => useComposerDraftStore.getState().getComposerDraft(ref)?.prompt ?? "";
    // Empty draft: no leading boundary.
    provider.invoke(invokeCall("insertMention", { threadId: "thread-a", paths: ["src/a.ts"] }));
    expect(readPrompt()).toBe("[a.ts](src/a.ts) ");
    // Non-whitespace tail: exactly one boundary space. The link bytes match
    // serializeComposerFileLink, including URL-escaped spaces and parens.
    provider.invoke(
      invokeCall("insertMention", { threadId: "thread-a", paths: ["src/a b(c).ts"] }),
    );
    expect(readPrompt()).toBe("[a.ts](src/a.ts) [a b(c).ts](src/a%20b%28c%29.ts) ");
    // Whitespace tail: no double space.
    provider.invoke(invokeCall("insertMention", { threadId: "thread-a", paths: ["z.ts"] }));
    expect(readPrompt()).toBe("[a.ts](src/a.ts) [a b(c).ts](src/a%20b%28c%29.ts) [z.ts](z.ts) ");
    // Multiple paths in one call append in order, boundary only where needed.
    useComposerDraftStore.getState().clearDraftThread(ref);
    provider.invoke(
      invokeCall("insertMention", { threadId: "thread-a", paths: ["one.ts", "two.ts"] }),
    );
    expect(readPrompt()).toBe("[one.ts](one.ts) [two.ts](two.ts) ");
  });

  it("insertMention rejects bad shapes, foreign threads, and missing grants", () => {
    const provider = createComposerClientProvider(makeDeps(["t3.composer/write"]));
    expectDenied(
      () => provider.invoke(invokeCall("insertMention", { threadId: "thread-a", paths: [] })),
      "provider-rejected",
    );
    expectDenied(
      () =>
        provider.invoke(
          invokeCall("insertMention", { threadId: "thread-a", paths: ["a".repeat(513)] }),
        ),
      "provider-rejected",
    );
    expectDenied(() =>
      provider.invoke(invokeCall("insertMention", { threadId: "thread-b", paths: ["a.ts"] })),
    );
    const ungranted = createComposerClientProvider(makeDeps([]));
    expectDenied(() =>
      ungranted.invoke(invokeCall("insertMention", { threadId: "thread-a", paths: ["a.ts"] })),
    );
  });

  it("insertTerminalContext normalizes like the native selection path and lands unmounted", () => {
    const provider = createComposerClientProvider(makeDeps(["t3.composer/write"]));
    const ref = scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a"));
    const result = provider.invoke(
      invokeCall("insertTerminalContext", {
        threadId: "thread-a",
        terminalId: " term-1 ",
        terminalLabel: "zsh",
        lineStart: 3.7,
        lineEnd: 1.2,
        text: "\r\n$ npm test\r\nok\r\n\n",
      }),
    ) as { inserted: boolean; target: string };
    expect(result.inserted).toBe(true);
    expect(result.target).toBe(`${ENV}:thread-a`);
    const draft = useComposerDraftStore.getState().getComposerDraft(ref)!;
    // Same normalization as normalizeTerminalContextSelection: CRLF folded,
    // edges stripped, ids trimmed, lines clamped (lineEnd floors above start).
    expect(draft.terminalContexts).toHaveLength(1);
    expect(draft.terminalContexts[0]).toMatchObject({
      terminalId: "term-1",
      terminalLabel: "zsh",
      lineStart: 3,
      lineEnd: 3,
      text: "$ npm test\nok",
    });
    // No mounted composer: the store itself appends the inline chip reference.
    expect(draft.prompt).toContain("t3-context://v1/terminal/");
    expect(draft.prompt).toContain("zsh line 3");
  });

  it("insertTerminalContext consults a mounted composer's insertion handler", () => {
    const provider = createComposerClientProvider(makeDeps(["t3.composer/write"]));
    const ref = scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a"));
    const handler: ReturnType<typeof vi.fn> & ComposerContextInsertionHandler = vi.fn(() => true);
    const unregister = useComposerDraftStore.getState().setContextInsertionHandler(ref, handler);
    try {
      const result = provider.invoke(
        invokeCall("insertTerminalContext", {
          threadId: "thread-a",
          terminalId: "term-2",
          terminalLabel: "bash",
          lineStart: 10,
          lineEnd: 12,
          text: "echo hi",
        }),
      ) as { inserted: boolean };
      expect(result.inserted).toBe(true);
      // The mounted path is the handler the real ChatComposer registers —
      // the store asked it to place the reference instead of appending.
      expect(handler).toHaveBeenCalledOnce();
      const references = handler.mock.calls[0]![0] as { kind: string }[];
      expect(references).toHaveLength(1);
      expect(references[0]!.kind).toBe("terminal");
      const draft = useComposerDraftStore.getState().getComposerDraft(ref)!;
      expect(draft.terminalContexts).toHaveLength(1);
      // Handler reported success, so the store did not append its own copy.
      expect(draft.prompt).not.toContain("t3-context://v1/terminal/");
    } finally {
      unregister?.();
    }
  });

  it("batched mention+terminal-context inserts survive the mounted stale-ref window", () => {
    const provider = createComposerClientProvider(makeDeps(["t3.composer/write"]));
    const ref = scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a"));
    const store = useComposerDraftStore.getState();
    // The mounted composer's promptRef and the draft store agree at rest.
    store.setPrompt(ref, "original");
    const promptRef: { current: string } = { current: "original" };

    // Mirrors ChatComposer's insertion seam: the store dispatches context to
    // the registered handler, whose insertComposerText body syncs promptRef
    // from the store draft before building the next prompt — a passive effect
    // alone cannot cover a store-only write that has not flushed yet.
    const handler: ComposerContextInsertionHandler = (references) => {
      const draftPrompt = useComposerDraftStore.getState().getComposerDraft(ref)?.prompt;
      if (draftPrompt !== undefined && draftPrompt !== promptRef.current) {
        promptRef.current = draftPrompt;
      }
      const prompt = promptRef.current;
      const boundary = prompt.length > 0 && !/\s/.test(prompt[prompt.length - 1] ?? "") ? " " : "";
      const next = `${prompt}${boundary}${references.map(formatInlineContextReference).join(" ")} `;
      promptRef.current = next;
      store.setPrompt(ref, next);
      return true;
    };
    const unregister = store.setContextInsertionHandler(ref, handler);
    try {
      // Both ops arrive in one batch, before any effect flushes the ref.
      const mention = provider.invoke(
        invokeCall("insertMention", { threadId: "thread-a", paths: ["keep.ts"] }),
      ) as { inserted: number };
      const terminal = provider.invoke(
        invokeCall("insertTerminalContext", {
          threadId: "thread-a",
          terminalId: "term-1",
          terminalLabel: "zsh",
          lineStart: 1,
          lineEnd: 2,
          text: "npm test",
        }),
      ) as { inserted: boolean };
      expect(mention.inserted).toBe(1);
      expect(terminal.inserted).toBe(true);
      const draft = useComposerDraftStore.getState().getComposerDraft(ref)!;
      expect(draft.terminalContexts).toHaveLength(1);
      // Both writes survive in order: the mention the first op wrote through
      // the store, and the terminal chip the handler appended to it.
      expect(draft.prompt.indexOf("[keep.ts](keep.ts)")).toBeGreaterThanOrEqual(0);
      const terminalAt = draft.prompt.indexOf("t3-context://v1/terminal/");
      expect(terminalAt).toBeGreaterThanOrEqual(0);
      expect(terminalAt).toBeGreaterThan(draft.prompt.indexOf("[keep.ts](keep.ts)"));
      expect(draft.prompt).toContain("zsh lines 1-2");
    } finally {
      unregister?.();
    }
  });

  it("insertTerminalContext reports the store's dedupe key as a duplicate", () => {
    const provider = createComposerClientProvider(makeDeps(["t3.composer/write"]));
    const base = {
      threadId: "thread-a",
      terminalId: "term-3",
      terminalLabel: "zsh",
      lineStart: 5,
      lineEnd: 6,
    };
    const first = provider.invoke(
      invokeCall("insertTerminalContext", { ...base, text: "ls -la" }),
    ) as { inserted: boolean; reason?: string };
    expect(first.inserted).toBe(true);
    const second = provider.invoke(
      invokeCall("insertTerminalContext", { ...base, text: "different text, same range" }),
    ) as { inserted: boolean; reason?: string };
    expect(second).toMatchObject({ inserted: false, reason: "duplicate" });
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a")))!;
    expect(draft.terminalContexts).toHaveLength(1);
  });

  it("insertTerminalContext rejects empty-after-normalization fields and bad ranges", () => {
    const provider = createComposerClientProvider(makeDeps(["t3.composer/write"]));
    const base = {
      threadId: "thread-a",
      terminalId: "t",
      terminalLabel: "l",
      lineStart: 1,
      lineEnd: 1,
    };
    expectDenied(
      () => provider.invoke(invokeCall("insertTerminalContext", { ...base, text: "\n\n\n" })),
      "provider-rejected",
    );
    expectDenied(
      () =>
        provider.invoke(
          invokeCall("insertTerminalContext", { ...base, text: "x", terminalId: "  " }),
        ),
      "provider-rejected",
    );
    expectDenied(
      () =>
        provider.invoke(
          invokeCall("insertTerminalContext", { ...base, text: "x", lineStart: "3" }),
        ),
      "provider-rejected",
    );
    expectDenied(() =>
      provider.invoke(
        invokeCall("insertTerminalContext", { ...base, text: "x", threadId: "thread-b" }),
      ),
    );
  });

  it("attachAnnotation diff kind stores a buildDiffReviewComment-shaped record", () => {
    const provider = createComposerClientProvider(makeDeps(["t3.messages/write"]));
    const result = provider.invoke(
      invokeCall("attachAnnotation", {
        threadId: "thread-a",
        annotation: {
          kind: "diff",
          filePath: "src/app.ts",
          sectionId: "diff:src/app.ts",
          sectionTitle: "Changes",
          rangeLabel: "+12",
          diff: "@@ -10,2 +10,2 @@\n context\n-old\n+new",
          selection: { start: 12, side: "additions", end: 12, endSide: "additions" },
          body: "  this breaks on windows",
        },
      }),
    ) as { annotationId: string };
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a")))!;
    const entry = draft.reviewComments.find((comment) => comment.id === result.annotationId)!;
    expect(entry).toMatchObject({
      sectionId: "diff:src/app.ts",
      sectionTitle: "Changes",
      filePath: "src/app.ts",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "+12",
      text: "this breaks on windows",
      diff: "@@ -10,2 +10,2 @@\n context\n-old\n+new",
      fenceLanguage: "diff",
      selection: { start: 12, side: "additions", end: 12, endSide: "additions" },
    });
    // The diff reference rides inline so the comment serializes on send.
    expect(draft.prompt).toContain("t3-context:");
  });

  it("attachAnnotation diff kind rejects malformed selections and unknown kinds", () => {
    const provider = createComposerClientProvider(makeDeps(["t3.messages/write"]));
    const diff = {
      kind: "diff",
      filePath: "a.ts",
      sectionId: "s",
      sectionTitle: "t",
      rangeLabel: "+1",
      diff: "+new",
      body: "x",
    };
    expectDenied(
      () =>
        provider.invoke(
          invokeCall("attachAnnotation", {
            threadId: "thread-a",
            annotation: {
              ...diff,
              selection: { start: 1, side: "up", end: 1, endSide: "up" },
            },
          }),
        ),
      "provider-rejected",
    );
    expectDenied(
      () =>
        provider.invoke(
          invokeCall("attachAnnotation", {
            threadId: "thread-a",
            annotation: {
              ...diff,
              selection: { start: 0, side: "additions", end: 1, endSide: "additions" },
            },
          }),
        ),
      "provider-rejected",
    );
    expectDenied(
      () =>
        provider.invoke(
          invokeCall("attachAnnotation", {
            threadId: "thread-a",
            annotation: { ...diff, kind: "span" },
          }),
        ),
      "provider-rejected",
    );
  });

  it("listAnnotations returns only the caller's own annotations, kind-tagged", () => {
    const provider = createComposerClientProvider(
      makeDeps(["t3.composer/write", "t3.messages/write"]),
    );
    const ref = scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a"));
    const file = provider.invoke(
      invokeCall("attachAnnotation", {
        threadId: "thread-a",
        annotation: { filePath: "src/f.ts", startLine: 2, endLine: 2, body: "file note" },
      }),
    ) as { annotationId: string };
    const diff = provider.invoke(
      invokeCall("attachAnnotation", {
        threadId: "thread-a",
        annotation: {
          kind: "diff",
          filePath: "src/g.ts",
          sectionId: "diff:src/g.ts",
          sectionTitle: "Changes",
          rangeLabel: "+1",
          diff: "+new",
          selection: { start: 1, side: "additions", end: 1, endSide: "additions" },
          body: "diff note",
        },
      }),
    ) as { annotationId: string };
    // Foreign records: another installation's annotation and an insertContext ref.
    useComposerDraftStore.getState().addReviewComment(ref, {
      id: "annotation:ext.b:foreign",
      sectionId: "file:other.ts",
      sectionTitle: "File comment",
      filePath: "other.ts",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "L1",
      text: "not yours",
      diff: "",
    });
    provider.invoke(
      invokeCall("insertContext", { threadId: "thread-a", refs: [{ path: "src/h.ts" }] }),
    );
    const listed = provider.invoke(invokeCall("listAnnotations", { threadId: "thread-a" })) as {
      annotations: { annotationId: string; kind: string; filePath: string }[];
    };
    expect(listed.annotations.map((entry) => entry.annotationId)).toEqual([
      file.annotationId,
      diff.annotationId,
    ]);
    expect(listed.annotations[0]).toMatchObject({ kind: "file", filePath: "src/f.ts" });
    expect(listed.annotations[1]).toMatchObject({ kind: "diff", filePath: "src/g.ts" });
    // A different installation sees none of ext.a's annotations.
    const other = installation(["t3.messages/write"], { id: "ext.b", contentHash: "hash-b" });
    const foreign = createComposerClientProvider({
      environmentId: EnvironmentId.make(ENV),
      client: "web",
      emit: vi.fn(),
      installations: () => [other],
    });
    const foreignListed = foreign.invoke(
      invokeCall(
        "listAnnotations",
        { threadId: "thread-a" },
        {
          caller: caller({ installationId: "ext.b", contentHash: "hash-b" }),
        },
      ),
    ) as { annotations: { annotationId: string }[] };
    // ext.b sees exactly its own seeded annotation — none of ext.a's.
    expect(foreignListed.annotations.map((entry) => entry.annotationId)).toEqual([
      "annotation:ext.b:foreign",
    ]);
    // Grant enforcement and thread scoping.
    expectDenied(() =>
      createComposerClientProvider(makeDeps([])).invoke(
        invokeCall("listAnnotations", { threadId: "thread-a" }),
      ),
    );
    expectDenied(() => provider.invoke(invokeCall("listAnnotations", { threadId: "thread-b" })));
  });

  it("removeAnnotation removes only the caller's own annotation and its reference", () => {
    const provider = createComposerClientProvider(makeDeps(["t3.messages/write"]));
    const ref = scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a"));
    const own = provider.invoke(
      invokeCall("attachAnnotation", {
        threadId: "thread-a",
        annotation: { filePath: "src/r.ts", startLine: 1, endLine: 1, body: "remove me" },
      }),
    ) as { annotationId: string };
    const draftWithReference = useComposerDraftStore.getState().getComposerDraft(ref)!;
    expect(draftWithReference.reviewComments).toHaveLength(1);
    expect(draftWithReference.prompt).toContain("t3-context:");
    // A foreign id is a named denial, not a silent no-op.
    expectDenied(() =>
      provider.invoke(
        invokeCall("removeAnnotation", {
          threadId: "thread-a",
          annotationId: "annotation:ext.b:x",
        }),
      ),
    );
    // The caller's ext-context refs are not annotations either.
    expectDenied(() =>
      provider.invoke(
        invokeCall("removeAnnotation", {
          threadId: "thread-a",
          annotationId: `ext-context:${INSTALL}:x`,
        }),
      ),
    );
    const removed = provider.invoke(
      invokeCall("removeAnnotation", { threadId: "thread-a", annotationId: own.annotationId }),
    ) as { removed: boolean };
    expect(removed.removed).toBe(true);
    const after = useComposerDraftStore.getState().getComposerDraft(ref);
    expect(after?.reviewComments ?? []).toHaveLength(0);
    // The inline reference went with the record.
    expect(after?.prompt ?? "").not.toContain("t3-context:");
    // Removing an already-gone own id stays honest and idempotent.
    const again = provider.invoke(
      invokeCall("removeAnnotation", { threadId: "thread-a", annotationId: own.annotationId }),
    ) as { removed: boolean };
    expect(again.removed).toBe(false);
    expectDenied(() =>
      provider.invoke(
        invokeCall("removeAnnotation", { threadId: "thread-b", annotationId: own.annotationId }),
      ),
    );
  });
});

describe("panels provider", () => {
  it("requires the panels grant and a known surface", () => {
    const noGrant = createPanelsClientProvider(makeDeps([]));
    expectDenied(() =>
      noGrant.invoke(
        invokeCall("openSurface", {
          threadId: "thread-a",
          surfaceId: SURFACE,
          placement: "side-panel",
        }),
      ),
    );
    const provider = createPanelsClientProvider(makeDeps(["t3.ui/panels"]));
    expectDenied(
      () =>
        provider.invoke(
          invokeCall("openSurface", {
            threadId: "thread-a",
            surfaceId: "ext.a/missing",
            placement: "side-panel",
          }),
        ),
      "panel-surface-not-found",
    );
  });

  it("defaults an omitted placement to the surface's first declared slot", () => {
    const dockOnly = {
      ...installation(["t3.ui/panels"]),
      package: {
        ...installation(["t3.ui/panels"]).package,
        manifest: {
          ...installation(["t3.ui/panels"]).package.manifest,
          surfaces: [
            {
              id: SURFACE,
              title: "Dock",
              placements: ["bottom-dock"],
              clients: ["web"],
              scope: "thread",
              capabilities: [],
              stateVersion: 1,
            },
          ],
        },
      },
    } as InstalledPackage;
    const provider = createPanelsClientProvider({
      environmentId: EnvironmentId.make(ENV),
      client: "web",
      emit: vi.fn(),
      installations: () => [dockOnly],
    });
    // Explicit wrong placement is rejected against the manifest declaration.
    expectDenied(
      () =>
        provider.invoke(
          invokeCall("openSurface", {
            threadId: "thread-a",
            surfaceId: SURFACE,
            placement: "side-panel",
          }),
        ),
      "provider-rejected",
    );
    // Omitted placement resolves to "bottom-dock" and proceeds — failing only
    // at the (unseeded) thread shell, not the placement declaration.
    expectDenied(
      () =>
        provider.invoke(invokeCall("openSurface", { threadId: "thread-a", surfaceId: SURFACE })),
      "panel-surface-not-found",
    );
  });

  it("lists no open surfaces on a fresh store and toggles the dock", () => {
    const provider = createPanelsClientProvider(makeDeps(["t3.ui/panels"]));
    const listed = provider.invoke(invokeCall("listSurfaces", { threadId: "thread-a" })) as {
      surfaces: unknown[];
    };
    expect(listed.surfaces).toEqual([]);
    expect(provider.invoke(invokeCall("showDock", { threadId: "thread-a" }))).toEqual({
      applied: true,
    });
    expect(provider.invoke(invokeCall("hideDock", { threadId: "thread-a" }))).toEqual({
      applied: true,
    });
  });
});

describe("terminal appearance provider", () => {
  it("reports the terminal theme derived from app state", () => {
    const provider = createTerminalAppearanceClientProvider(makeDeps(["t3.ui/theme.read"]));
    const snapshot = provider.invoke(invokeCall("getAppearance", {})) as {
      theme: { background: string; foreground: string; cursor: string };
      appearance: string;
    };
    expect(snapshot.theme.background).toBe("rgb(10, 20, 30)");
    expect(snapshot.appearance).toBe("light");
  });

  it("streams a snapshot for watchAppearance", () => {
    const provider = createTerminalAppearanceClientProvider(makeDeps(["t3.ui/theme.read"]));
    const events: ClientProviderEmitEvent[] = [];
    const close = provider.openStream!({
      name: "watchAppearance",
      input: null,
      context: context(),
      caller: caller(),
      emit: (event) => events.push(event),
    });
    expect(events[0]?.type).toBe("snapshot");
    if (typeof close === "function") close();
  });
});

describe("keybindings provider", () => {
  const keybindingsDeps = (): ExtensionCommandEnvironmentDeps => ({
    installationGeneration: (id) => (id === INSTALL ? 1 : null),
    installationSurfaces: (id) =>
      id === INSTALL
        ? [
            {
              id: SURFACE,
              title: "Panel",
              placements: ["side-panel"],
              clients: ["web"],
              scope: "thread",
              stateVersion: 1,
            },
          ]
        : null,
    installationGrants: (id) => (id === INSTALL ? ["project-a"] : null),
    client: "web",
  });

  it("rejects callers without the keybindings grant and registers for granted ones", () => {
    configureExtensionCommandEnvironment(ENV, keybindingsDeps());
    const providers = createClientProviders(makeDeps([]));
    const denied = providers.get("t3.client/keybindings")!;
    expectDenied(() =>
      denied.invoke(
        invokeCall("registerCommands", {
          commands: [{ id: "run", title: "Run", scope: "surface" }],
        }),
      ),
    );
    const granted = createClientProviders(makeDeps(["t3.ui/keybindings"])).get(
      "t3.client/keybindings",
    )!;
    const registered = granted.invoke(
      invokeCall("registerCommands", {
        commands: [{ id: "run", title: "Run", scope: "surface" }],
      }),
    ) as { commandSetToken: string; results: { status: string }[] };
    expect(registered.commandSetToken).toBeTruthy();
    expect(registered.results[0]?.status).toBe("registered");
  });
});

describe("theme overlay restoration", () => {
  it("persist clears the painted session overlay", () => {
    const provider = createThemeClientProvider(makeDeps(THEME_CAPS));
    provider.invoke(
      invokeCall("applyPreference", {
        writer: INSTALL,
        preference: { mode: "session", theme: "ocean" },
      }),
    );
    expect(document.documentElement.dataset.themeId).toBe(THEME_PREVIEW_ID);
    expect(
      provider.invoke(
        invokeCall("applyPreference", {
          writer: INSTALL,
          preference: { mode: "persist", theme: "ocean" },
        }),
      ),
    ).toMatchObject({ applied: true });
    expect(document.documentElement.dataset.themeId).not.toBe(THEME_PREVIEW_ID);
    expect(provider.invoke(invokeCall("getState", {}))).toMatchObject({
      effectiveTheme: { kind: "stored" },
      sessionOverlay: null,
    });
  });

  it("a native refresh clears the overlay token resolution used", () => {
    const provider = createThemeClientProvider(makeDeps(THEME_CAPS));
    themeStore.setTheme("light");
    themeStore.refreshTheme();
    const before = provider.invoke(invokeCall("resolveTokens", {}));
    provider.invoke(
      invokeCall("applyPreference", {
        writer: INSTALL,
        preference: { mode: "session", theme: "ocean" },
      }),
    );
    themeStore.refreshTheme();
    expect(provider.invoke(invokeCall("getState", {}))).toMatchObject({
      effectiveTheme: { kind: "stored" },
    });
    expect(provider.invoke(invokeCall("resolveTokens", {}))).toEqual(before);
  });
});

describe("terminal appearance settings stream", () => {
  it("a font-only settings update emits appearance and unsubscribe cleans up", async () => {
    const baseline = getClientSettings();
    __setClientSettingsForTests(baseline);
    const provider = createTerminalAppearanceClientProvider(makeDeps(["t3.ui/theme.read"]));
    const events: ClientProviderEmitEvent[] = [];
    const close = await provider.openStream!({
      name: "watchAppearance",
      input: null,
      context: context(),
      caller: caller(),
      emit: (event) => events.push(event),
    });
    try {
      await persistClientSettingsPatch(
        { fontSizeTerminal: baseline.fontSizeTerminal + 1 },
        async () => {},
      );
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        type: "data",
        value: { font: { size: baseline.fontSizeTerminal + 1 } },
      });
      close();
      await persistClientSettingsPatch(
        { fontSizeTerminal: baseline.fontSizeTerminal + 2 },
        async () => {},
      );
      expect(events).toHaveLength(2);
    } finally {
      close();
      __setClientSettingsForTests(baseline);
    }
  });
});

it("persisted preferences preserve the native editor paint", () => {
  const provider = createThemeClientProvider(makeDeps(THEME_CAPS));
  provider.invoke(
    invokeCall("applyPreference", {
      writer: INSTALL,
      preference: { mode: "session", theme: "ocean" },
    }),
  );
  transferThemePreviewOwner("editor");
  applyThemeColorPreview({} as never, "light", "editor");
  expect(
    provider.invoke(
      invokeCall("applyPreference", {
        writer: INSTALL,
        preference: { mode: "persist", theme: "ocean" },
      }),
    ),
  ).toMatchObject({ applied: true });
  expect(document.documentElement.dataset.themePreviewOwner).toBe("editor");
  expect(provider.invoke(invokeCall("getState", {}))).toMatchObject({
    effectiveTheme: { kind: "external-preview" },
    sessionOverlay: null,
  });
});
