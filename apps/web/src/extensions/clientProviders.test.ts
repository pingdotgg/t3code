import * as NodeModule from "node:module";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EditorId,
  EnvironmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
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
import { toastManager, type ThreadToastData } from "../components/ui/toast";
import { formatInlineContextReference } from "../lib/composerContextReferences";
import { useComposerDraftStore, type ComposerContextInsertionHandler } from "../composerDraftStore";
import { retainBrowserCaptureAnnotation } from "./browserCaptureAnnotations";
import {
  CLIENT_PROVIDER_DESCRIPTORS,
  createClientProviders,
  createComposerClientProvider,
  createEditorClientProvider,
  createExternalClientProvider,
  createNotificationsClientProvider,
  createPanelsClientProvider,
  createTerminalAppearanceClientProvider,
  createThemeClientProvider,
  type ClientProviderDeps,
} from "./clientProviders";
import { CLIENT_PROVIDER_APIS } from "@t3tools/extension-sdk/clientProviders";
import { ClientProviderOpError, type ClientProviderInvokeCall } from "./clientProviderTypes";
import {
  configureExtensionCommandEnvironment,
  unconfigureExtensionCommandEnvironment,
  type ExtensionCommandEnvironmentDeps,
} from "./extensionCommandRegistry";
import type { InstalledPackage } from "./installedController";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { setLocalStorageItem } from "../hooks/useLocalStorage";
import { useRightPanelStore } from "../rightPanelStore";
import { usePreviewMiniPlayerStore } from "../previewMiniPlayerStore";
import { useBrowserSurfaceStore } from "../browser/browserSurfaceStore";
import { resourceKey } from "@t3tools/extension-sdk/contracts";
import {
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { resolveRemoteOpenState } from "../remoteOpen";
import { getLocalStorageItem } from "../hooks/useLocalStorage";
import * as Schema from "effect/Schema";

// Base UI keeps ToastStore internal; tests drive the real store to cover its timer rules.
const requireFromHere = NodeModule.createRequire(import.meta.url);
const { ToastStore } = requireFromHere(
  NodePath.join(NodePath.dirname(requireFromHere.resolve("@base-ui/react/toast")), "store.js"),
);

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
const unusedPrHandoff = {
  openThread: async () => null,
  prepare: async () => ({ ok: false as const, detail: null }),
};

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

describe("browser SDK native parity seams", () => {
  const threadRef = scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a"));
  const previewState = { serverEpoch: "epoch-a", sessions: { "tab-a": {} } };
  beforeEach(() =>
    useBrowserSurfaceStore.setState({
      extensionTargetsByResourceKey: {
        [resourceKey(context().resource)]: {
          installationId: INSTALL,
          tabId: "tab-a",
          serverEpoch: "epoch-a",
          runtimeTabId: "runtime-a",
        },
      },
    }),
  );
  afterEach(() => useBrowserSurfaceStore.setState({ extensionTargetsByResourceKey: {} }));

  it("rejects sessions never held by this installation without changing another panel", () => {
    useBrowserSurfaceStore.setState({ extensionTargetsByResourceKey: {} });
    useRightPanelStore.getState().open(threadRef, "diff");
    const provider = createPanelsClientProvider(
      makeDeps(["t3.ui/panels", "t3.browser/sessions"]),
      () => previewState,
      () => true,
    );
    expectDenied(
      () =>
        provider.invoke(
          invokeCall("setBrowserMiniPlayer", {
            threadId: "thread-a",
            tabId: "tab-a",
            serverEpoch: "epoch-a",
            open: true,
          }),
        ),
      "client-target-denied",
    );
    expect(
      Object.values(useRightPanelStore.getState().byThreadKey).some(
        (panel) => panel.isOpen && panel.activeSurfaceId === "diff",
      ),
    ).toBe(true);
  });

  it.each(["attach", "send"] as const)(
    "only the trusted picker submission can request a native send: %s",
    (submission) => {
      const nativeSend = vi.fn();
      const read = vi.fn(() => ({
        annotation: {
          id: "native-send",
          pageUrl: "https://example.com",
          pageTitle: "Page",
          comment: "fix",
          elements: [],
          regions: [],
          strokes: [],
          styleChanges: [],
          screenshot: null,
          createdAt: "2026-09-30T00:00:00Z",
        },
        file: null,
        artifactRef: null,
        screenshotFailed: false,
        submission,
        consume: vi.fn(),
      }));
      const provider = createComposerClientProvider(
        makeDeps(["t3.composer/write"]),
        undefined,
        undefined,
        read,
        nativeSend,
      );
      provider.invoke(
        invokeCall("insertPreviewAnnotation", {
          threadId: "thread-a",
          annotationRef: "native-ref",
        }),
      );
      expect(nativeSend).toHaveBeenCalledTimes(submission === "send" ? 1 : 0);
    },
  );

  it("opens the native mini-player, preserves its geometry, and closes only the requested source", () => {
    usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
    useRightPanelStore.getState().openBrowser(threadRef, "tab-a");
    const provider = createPanelsClientProvider(
      makeDeps(["t3.ui/panels", "t3.browser/sessions"]),
      () => previewState,
      () => true,
    );
    const input = { threadId: "thread-a", tabId: "tab-a", serverEpoch: "epoch-a", open: true };
    expect(provider.invoke(invokeCall("setBrowserMiniPlayer", input))).toEqual({ tabId: "tab-a" });
    expect(
      Object.values(useRightPanelStore.getState().byThreadKey).find((panel) =>
        panel.surfaces.some((surface) => surface.id === "browser:tab-a"),
      )?.isOpen,
    ).toBe(true);
    usePreviewMiniPlayerStore.getState().move(threadRef, "browser:tab-a", { x: 32, y: 64 });
    provider.invoke(invokeCall("setBrowserMiniPlayer", input));
    expect(Object.values(usePreviewMiniPlayerStore.getState().byThreadKey)[0]?.position).toEqual({
      x: 32,
      y: 64,
    });
    expect(provider.invoke(invokeCall("getBrowserMiniPlayer", { threadId: "thread-a" }))).toEqual({
      tabId: "tab-a",
    });
    expectDenied(
      () =>
        provider.invoke(
          invokeCall("setBrowserMiniPlayer", { ...input, tabId: "other", open: false }),
        ),
      "client-target-denied",
    );
    expect(Object.values(usePreviewMiniPlayerStore.getState().byThreadKey)).toHaveLength(1);
    provider.invoke(invokeCall("setBrowserMiniPlayer", { ...input, open: false }));
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
  });

  it("does not close a device player when closing a browser source", () => {
    usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
    usePreviewMiniPlayerStore.getState().open(threadRef, {
      kind: "device",
      hostId: "host-a",
      deviceId: "device-a",
      platform: "ios",
      name: "Phone",
    });
    const provider = createPanelsClientProvider(
      makeDeps(["t3.ui/panels", "t3.browser/sessions"]),
      () => previewState,
      () => true,
    );
    expect(
      provider.invoke(
        invokeCall("setBrowserMiniPlayer", {
          threadId: "thread-a",
          tabId: "tab-a",
          serverEpoch: "epoch-a",
          open: false,
        }),
      ),
    ).toEqual({ tabId: null });
    expect(Object.values(usePreviewMiniPlayerStore.getState().byThreadKey)[0]?.source.kind).toBe(
      "device",
    );
    usePreviewMiniPlayerStore.getState().close(threadRef);
  });

  it("rejects mini-player requests without browser authority or with a stale or foreign session", () => {
    const noBrowser = createPanelsClientProvider(
      makeDeps(["t3.ui/panels"]),
      () => previewState,
      () => true,
    );
    const provider = createPanelsClientProvider(
      makeDeps(["t3.ui/panels", "t3.browser/sessions"]),
      () => previewState,
      () => true,
    );
    const input = { threadId: "thread-a", tabId: "tab-a", serverEpoch: "epoch-a", open: true };
    expectDenied(() => noBrowser.invoke(invokeCall("setBrowserMiniPlayer", input)));
    expectDenied(() =>
      provider.invoke(invokeCall("setBrowserMiniPlayer", { ...input, threadId: "other" })),
    );
    expectDenied(
      () => provider.invoke(invokeCall("setBrowserMiniPlayer", { ...input, serverEpoch: "old" })),
      "provider-rejected",
    );
    expectDenied(
      () => provider.invoke(invokeCall("setBrowserMiniPlayer", { ...input, tabId: "other" })),
      "client-target-denied",
    );
  });

  it("inserts a native annotation chip without losing the user's prompt", () => {
    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    useComposerDraftStore.getState().setPrompt(threadRef, "Please fix this");
    const annotation = {
      id: "pick-a",
      pageUrl: "https://example.com",
      pageTitle: "Example",
      comment: "make it blue",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "2026-09-30T00:00:00Z",
    };
    const readAnnotation = vi.fn(() => ({
      annotation,
      file: null,
      artifactRef: null,
      screenshotFailed: false,
      consume: vi.fn(),
    }));
    const provider = createComposerClientProvider(
      makeDeps(["t3.composer/write"]),
      undefined,
      undefined,
      readAnnotation,
    );
    expect(
      provider.invoke(
        invokeCall("insertPreviewAnnotation", { threadId: "thread-a", annotationRef: "pick-ref" }),
      ),
    ).toEqual({
      inserted: true,
      imageInserted: false,
      screenshotFailed: false,
      target: "env-a:thread-a",
    });
    const draft = useComposerDraftStore.getState().getComposerDraft(threadRef)!;
    expect(draft.previewAnnotations).toEqual([annotation]);
    expect(draft.prompt).toContain("Please fix this");
    expect(draft.prompt).not.toBe("Please fix this");
    expect(readAnnotation).toHaveBeenCalledWith(ENV, "thread-a", INSTALL, "pick-ref");
  });

  it.each([false, true])(
    "keeps native annotation text and geometry when the composer is full: %s",
    (full) => {
      useComposerDraftStore.setState({ draftsByThreadKey: {} });
      const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "selection.png", {
        type: "image/png",
      });
      if (full)
        useComposerDraftStore.getState().addImages(
          threadRef,
          Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, index) => ({
            type: "image" as const,
            id: `existing-${index}`,
            name: `existing-${index}.png`,
            mimeType: "image/png",
            sizeBytes: 4,
            previewUrl: `blob:existing-${index}`,
            file: new File([file], `existing-${index}.png`, { type: "image/png" }),
          })),
        );
      const annotation = {
        id: "selection-a",
        pageUrl: "https://example.com",
        pageTitle: "Example",
        comment: "Move this region",
        elements: [],
        regions: [{ id: "region-a", rect: { x: 1, y: 2, width: 3, height: 4 } }],
        strokes: [],
        styleChanges: [],
        screenshot: {
          dataUrl: "data:image/png;base64,iVBORw==",
          width: 3,
          height: 4,
          cropRect: { x: 1, y: 2, width: 3, height: 4 },
        },
        createdAt: "2026-09-30T00:00:00Z",
      };
      const lifetime = new AbortController();
      const retained = retainBrowserCaptureAnnotation({
        environmentId: ENV,
        threadId: "thread-a",
        installationId: INSTALL,
        lifetime: lifetime.signal,
        annotation,
        file,
        screenshotFailed: false,
      });
      retained.setArtifact("pending-selection");
      const release = vi.fn();
      const provider = createComposerClientProvider(
        makeDeps(["t3.composer/write"]),
        undefined,
        release,
      );
      const input = { threadId: "thread-a", annotationRef: retained.annotationRef };
      expect(provider.invoke(invokeCall("insertPreviewAnnotation", input))).toEqual({
        inserted: true,
        imageInserted: !full,
        screenshotFailed: full,
        target: "env-a:thread-a",
      });
      const draft = useComposerDraftStore.getState().getComposerDraft(threadRef)!;
      expect(draft.previewAnnotations).toEqual([
        { ...annotation, screenshot: full ? null : { ...annotation.screenshot, dataUrl: "" } },
      ]);
      expect(draft.images.some((image) => image.id === annotation.id)).toBe(!full);
      expect(JSON.stringify(draft.previewAnnotations)).not.toContain("base64");
      expect(release).toHaveBeenCalledExactlyOnceWith(ENV, "pending-selection");
      expectDenied(
        () => provider.invoke(invokeCall("insertPreviewAnnotation", input)),
        "provider-rejected",
      );
      lifetime.abort();
    },
  );

  it("does not insert an annotation without write authority or outside its owning scope", () => {
    const lifetime = new AbortController();
    const annotation = {
      id: "private-pick",
      pageUrl: "https://example.com",
      pageTitle: "Example",
      comment: "private comment",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "2026-09-30T00:00:00Z",
    };
    const retained = retainBrowserCaptureAnnotation({
      environmentId: ENV,
      threadId: "thread-a",
      installationId: "other",
      lifetime: lifetime.signal,
      annotation,
      file: null,
      screenshotFailed: false,
    });
    const input = { threadId: "thread-a", annotationRef: retained.annotationRef };
    expectDenied(() =>
      createComposerClientProvider(makeDeps([])).invoke(
        invokeCall("insertPreviewAnnotation", input),
      ),
    );
    const provider = createComposerClientProvider(makeDeps(["t3.composer/write"]));
    expectDenied(
      () => provider.invoke(invokeCall("insertPreviewAnnotation", input)),
      "provider-rejected",
    );
    expectDenied(() =>
      provider.invoke(invokeCall("insertPreviewAnnotation", { ...input, threadId: "other" })),
    );
    expect(
      useComposerDraftStore.getState().getComposerDraft(threadRef)?.previewAnnotations ?? [],
    ).toEqual([]);
    lifetime.abort();
  });
});

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
    expect(resolved).not.toHaveProperty("uiKitVersion");
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

  it("keeps the toast open for keepOpen actions and flashes a confirmation label", () => {
    vi.useFakeTimers();
    try {
      const emits: [string, ClientProviderEmitEvent][] = [];
      const provider = createNotificationsClientProvider(
        makeDeps(["t3.ui/notify"], (correlationId, event) => emits.push([correlationId, event])),
      );
      vi.spyOn(toastManager, "add").mockReturnValue("toast-k" as never);
      const updateSpy = vi.spyOn(toastManager, "update").mockImplementation(() => {});
      const closeSpy = vi.spyOn(toastManager, "close").mockImplementation(() => {});
      provider.invoke(
        invokeCall("notify", {
          notification: {
            notificationId: "n-k",
            severity: "success",
            title: "Screenshot saved",
            actions: [
              { id: "copy-path", label: "Copy path", keepOpen: true },
              { id: "open", label: "Open" },
            ],
          },
        }),
      );
      type Actions = {
        id: string;
        props: { children: string; disabled?: boolean; onClick: () => void };
      }[];
      const addOptions = vi.mocked(toastManager.add).mock.calls[0]![0] as unknown as {
        data: { additionalActions: Actions };
      };
      addOptions.data.additionalActions[0]!.props.onClick();
      addOptions.data.additionalActions[0]!.props.onClick();
      expect(emits).toEqual([
        ["n-k", { type: "notificationAction", actionId: "copy-path" }],
        ["n-k", { type: "notificationAction", actionId: "copy-path" }],
      ]);
      expect(closeSpy).not.toHaveBeenCalled();

      provider.invoke(
        invokeCall("update", {
          notificationId: "n-k",
          patch: { flashAction: { actionId: "copy-path", label: "Copied!", durationMs: 2000 } },
        }),
      );
      const labels = () =>
        (
          updateSpy.mock.calls.at(-1)![1] as { data: { additionalActions: Actions } }
        ).data.additionalActions.map(({ props }) => [props.children, props.disabled]);
      expect(labels()).toEqual([
        ["Copied!", true],
        ["Open", false],
      ]);
      vi.advanceTimersByTime(2000);
      expect(labels()).toEqual([
        ["Copy path", false],
        ["Open", false],
      ]);
      expectDenied(
        () =>
          provider.invoke(
            invokeCall("update", {
              notificationId: "n-k",
              patch: { flashAction: { actionId: "nope", label: "Copied!", durationMs: 10 } },
            }),
          ),
        "provider-rejected",
      );

      // A plain action still settles and closes.
      const latest = updateSpy.mock.calls.at(-1)![1] as { data: { additionalActions: Actions } };
      latest.data.additionalActions[1]!.props.onClick();
      expect(emits.at(-1)).toEqual([
        "n-k",
        { type: "notificationOutcome", outcome: { actionId: "open" } },
      ]);
      expect(closeSpy).toHaveBeenCalledWith("toast-k");
    } finally {
      vi.useRealTimers();
    }
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

  it("hands durationMs to the toast manager, whose timer pauses under the pointer", () => {
    vi.useFakeTimers();
    try {
      const emits: [string, ClientProviderEmitEvent][] = [];
      const provider = createNotificationsClientProvider(
        makeDeps(["t3.ui/notify"], (correlationId, event) => emits.push([correlationId, event])),
      );
      const addSpy = vi.spyOn(toastManager, "add").mockReturnValue("toast-3" as never);
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
      const toastOptions = addSpy.mock.calls[0]![0] as unknown as {
        timeout: number;
        onClose: () => void;
      };
      expect(toastOptions.timeout).toBe(4000);
      // A hovered toast outlives its duration: no timer of our own closes it.
      vi.advanceTimersByTime(10_000);
      expect(emits).toEqual([]);
      expect(closeSpy).not.toHaveBeenCalled();
      // The manager's timed close fires onClose, so a parked awaitAction is never stranded.
      toastOptions.onClose();
      expect(emits).toEqual([
        ["n-3", { type: "notificationOutcome", outcome: { dismissed: true } }],
      ]);
      // Settled notifications expire honestly for later management.
      expectDenied(
        () => provider.invoke(invokeCall("dismiss", { notificationId: "n-3" })),
        "notification-expired",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  describe("with the native toast store", () => {
    interface StoreToast {
      type?: string;
      timeout?: number;
      transitionStatus?: string;
      data?: ThreadToastData;
    }
    // Wires the manager to a real store exactly as Base UI's ToastProvider does.
    function toastHarness() {
      const store = new ToastStore({
        timeout: 5000,
        limit: 3,
        viewport: null,
        toasts: [],
        hovering: false,
        focused: false,
        isWindowFocused: true,
        prevFocusElement: null,
      });
      const unsubscribe = (
        toastManager as unknown as {
          " subscribe": (
            listener: (event: { action: string; options: { id: string } }) => void,
          ) => () => void;
        }
      )[" subscribe"](({ action, options }) => {
        if (action === "update") store.updateToast(options.id, options);
        else if (action === "close") store.closeToast(options.id);
        else store.addToast(options);
      });
      const emits: [string, ClientProviderEmitEvent][] = [];
      const provider = createNotificationsClientProvider(
        makeDeps(["t3.ui/notify"], (correlationId, event) => emits.push([correlationId, event])),
      );
      return {
        store,
        emits,
        provider,
        toasts: () => store.state.toasts as StoreToast[],
        dispose() {
          unsubscribe();
          store.disposeEffect()();
        },
      };
    }
    const dismissed = (id: string) => [
      id,
      { type: "notificationOutcome", outcome: { dismissed: true } },
    ];

    it("honors durationMs on a loading notification and pauses it while hovered", () => {
      vi.useFakeTimers();
      const h = toastHarness();
      try {
        h.provider.invoke(
          invokeCall("notify", {
            notification: {
              notificationId: "n-load",
              severity: "loading",
              title: "Working",
              durationMs: 5000,
            },
          }),
        );
        const spinner = h.toasts()[0]!.data?.leadingIcon;
        vi.advanceTimersByTime(3000);
        h.store.setHovering(true);
        h.store.pauseTimers();
        vi.advanceTimersByTime(10_000);
        expect(h.emits).toEqual([]);
        h.store.setHovering(false);
        h.store.resumeTimers();
        vi.advanceTimersByTime(2001);
        expect(h.emits).toEqual([dismissed("n-load")]);
        // The spinner still renders even though the store type is timer-bearing.
        expect(spinner).toBeTruthy();
      } finally {
        h.dispose();
        vi.useRealTimers();
      }
    });

    it("keeps an explicit lifetime across severity changes to and from loading", () => {
      vi.useFakeTimers();
      const h = toastHarness();
      try {
        h.provider.invoke(
          invokeCall("notify", {
            notification: {
              notificationId: "n-to",
              severity: "success",
              title: "Saved",
              durationMs: 5000,
            },
          }),
        );
        vi.advanceTimersByTime(2000);
        h.provider.invoke(
          invokeCall("update", { notificationId: "n-to", patch: { severity: "loading" } }),
        );
        const spinner = h.toasts()[0]!.data?.leadingIcon;
        vi.advanceTimersByTime(3001);
        expect(h.emits).toEqual([dismissed("n-to")]);
        expect(spinner).toBeTruthy();

        h.provider.invoke(
          invokeCall("notify", {
            notification: {
              notificationId: "n-from",
              severity: "loading",
              title: "Working",
              durationMs: 5000,
            },
          }),
        );
        vi.advanceTimersByTime(2000);
        h.provider.invoke(
          invokeCall("update", { notificationId: "n-from", patch: { severity: "success" } }),
        );
        const toast = h.toasts().find((candidate) => candidate.transitionStatus !== "ending")!;
        expect(toast.type).toBe("success");
        expect(toast.data?.leadingIcon).toBeUndefined();
        vi.advanceTimersByTime(3001);
        expect(h.emits).toEqual([dismissed("n-to"), dismissed("n-from")]);
      } finally {
        h.dispose();
        vi.useRealTimers();
      }
    });

    it("leaves a loading notification without durationMs open, like native", () => {
      vi.useFakeTimers();
      const h = toastHarness();
      try {
        h.provider.invoke(
          invokeCall("notify", {
            notification: { notificationId: "n-open", severity: "loading", title: "Working" },
          }),
        );
        vi.advanceTimersByTime(60_000);
        expect(h.toasts()[0]!.type).toBe("loading");
        expect(h.emits).toEqual([]);
      } finally {
        h.dispose();
        vi.useRealTimers();
      }
    });
  });

  it("puts a trailing primary action in native's bottom action row", () => {
    const emits: [string, ClientProviderEmitEvent][] = [];
    const provider = createNotificationsClientProvider(
      makeDeps(["t3.ui/notify"], (correlationId, event) => emits.push([correlationId, event])),
    );
    const addSpy = vi.spyOn(toastManager, "add").mockReturnValue("toast-s" as never);
    const updateSpy = vi.spyOn(toastManager, "update").mockImplementation(() => {});
    provider.invoke(
      invokeCall("notify", {
        notification: {
          notificationId: "n-s",
          severity: "success",
          title: "Screenshot saved",
          actions: [
            { id: "copy-path", label: "Copy path", keepOpen: true },
            { id: "reveal", label: "Reveal in Finder", keepOpen: true },
            { id: "copy-image", label: "Copy image", variant: "primary", keepOpen: true },
          ],
        },
      }),
    );
    type Button = { children: string; disabled?: boolean; onClick: () => void };
    const options = addSpy.mock.calls[0]![0] as unknown as {
      actionProps?: Button;
      data: { actionLayout?: string; additionalActions: { id: string; props: Button }[] };
    };
    expect(options.data.actionLayout).toBe("stacked-end");
    expect(options.actionProps?.children).toBe("Copy image");
    expect(options.data.additionalActions.map(({ id }) => id)).toEqual(["copy-path", "reveal"]);
    options.actionProps!.onClick();
    expect(emits).toEqual([["n-s", { type: "notificationAction", actionId: "copy-image" }]]);

    provider.invoke(
      invokeCall("update", {
        notificationId: "n-s",
        patch: { flashAction: { actionId: "copy-image", label: "Copied!", durationMs: 2000 } },
      }),
    );
    const patch = updateSpy.mock.calls.at(-1)![1] as { actionProps?: Button };
    expect(patch.actionProps).toMatchObject({ children: "Copied!", disabled: true });
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

  it("inserts a capture artifact as a draft image, fetched by ref", async () => {
    const artifactRef = "pending-0f1e2d3c-4b5a-4968-8776-655443322110";
    const fetchArtifact = vi.fn(
      async (_environmentId: string, _ref: string, name: string) =>
        new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" }),
    );
    const releaseArtifact = vi.fn();
    const provider = createComposerClientProvider(
      makeDeps(["t3.composer/write"]),
      fetchArtifact,
      releaseArtifact,
    );
    const result = await provider.invoke(
      invokeCall("insertImage", { threadId: "thread-a", artifactRef, name: "page.png" }),
    );
    expect(result).toEqual({ inserted: true, target: `${ENV}:thread-a` });
    expect(fetchArtifact).toHaveBeenCalledWith(ENV, artifactRef, "page.png");
    // The draft uploads its own copy, so the capture's pending upload is released
    // instead of lingering as an orphan until the store's sweep.
    expect(releaseArtifact).toHaveBeenCalledExactlyOnceWith(ENV, artifactRef);
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a")));
    const image = draft?.images.find((entry) => entry.name === "page.png");
    expect(image).toMatchObject({ type: "image", mimeType: "image/png", sizeBytes: 4 });
  });

  it("keeps the capture when a full composer refuses the image", async () => {
    const ref = scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a"));
    const png = (name: string) =>
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });
    useComposerDraftStore.getState().addImages(
      ref,
      Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, index) => ({
        type: "image" as const,
        id: `full-${index}`,
        name: `full-${index}.png`,
        mimeType: "image/png",
        sizeBytes: 4,
        previewUrl: `blob:full-${index}`,
        file: png(`full-${index}.png`),
      })),
    );
    const artifactRef = "pending-0f1e2d3c-4b5a-4968-8776-655443322110";
    const releaseArtifact = vi.fn();
    const provider = createComposerClientProvider(
      makeDeps(["t3.composer/write"]),
      async () => png("capture.png"),
      releaseArtifact,
    );
    const result = await provider.invoke(
      invokeCall("insertImage", { threadId: "thread-a", artifactRef, name: "capture.png" }),
    );
    expect(result).toEqual({ inserted: false, target: `${ENV}:thread-a` });
    const images = useComposerDraftStore.getState().getComposerDraft(ref)?.images ?? [];
    expect(images.some((image) => image.name === "capture.png")).toBe(false);
    // The draft holds no copy, so the capture's upload is the only one left and
    // stays for a retry once the composer has room.
    expect(releaseArtifact).not.toHaveBeenCalled();
  });

  it("refuses insertImage without the grant, outside scope, or with a non-capture ref", async () => {
    const artifactRef = "pending-0f1e2d3c-4b5a-4968-8776-655443322110";
    const fetchArtifact = vi.fn(async () => {
      throw new Error("The artifact is not a PNG capture.");
    });
    const releaseArtifact = vi.fn();
    expectDenied(() =>
      createComposerClientProvider(makeDeps([]), fetchArtifact, releaseArtifact).invoke(
        invokeCall("insertImage", { threadId: "thread-a", artifactRef }),
      ),
    );
    const provider = createComposerClientProvider(
      makeDeps(["t3.composer/write"]),
      fetchArtifact,
      releaseArtifact,
    );
    expectDenied(() =>
      provider.invoke(invokeCall("insertImage", { threadId: "thread-b", artifactRef })),
    );
    expectDenied(
      () =>
        provider.invoke(
          invokeCall("insertImage", {
            threadId: "thread-a",
            artifactRef: "data:image/png;base64,iVBORw0KGgo=",
          }),
        ),
      "provider-rejected",
    );
    expect(fetchArtifact).not.toHaveBeenCalled();
    // A ref whose bytes are not a capture is a named rejection, not an insert.
    await expect(
      provider.invoke(invokeCall("insertImage", { threadId: "thread-a", artifactRef })),
    ).rejects.toMatchObject({ code: "provider-rejected", message: /not a PNG capture/ });
    // A refused ref is not the draft's to delete.
    expect(releaseArtifact).not.toHaveBeenCalled();
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

  // Native parity: the composer chip shows the comment's words, so a listing
  // that asks for them gets a bounded preview of each own comment's text.
  it("listAnnotations carries each comment's text only when asked", () => {
    const provider = createComposerClientProvider(makeDeps(["t3.messages/write"]));
    const long = "word ".repeat(60);
    for (const body of ["  short note  ", long])
      provider.invoke(
        invokeCall("attachAnnotation", {
          threadId: "thread-a",
          annotation: { filePath: "src/f.ts", startLine: 1, endLine: 1, body },
        }),
      );
    const list = (input: Record<string, unknown>) =>
      (
        provider.invoke(invokeCall("listAnnotations", { threadId: "thread-a", ...input })) as {
          annotations: { text?: string }[];
        }
      ).annotations.map((entry) => entry.text);
    expect(list({})).toEqual([undefined, undefined]);
    const [short, preview] = list({ include: ["text"] });
    expect(short).toBe("short note");
    expect(preview).toHaveLength(160);
    expect(preview).toBe(`${long.trim().slice(0, 159)}…`);
  });

  // A listing's preview is marked cut, and
  // one own comment's whole text is readable on its own, within the frame.
  it("getAnnotation returns one own comment's whole text within the frame budget", () => {
    const provider = createComposerClientProvider(makeDeps(["t3.messages/write"]));
    // Every unit of the longest body JSON-escapes to six bytes.
    const body = "\u0001".repeat(4096);
    const { annotationId } = provider.invoke(
      invokeCall("attachAnnotation", {
        threadId: "thread-a",
        annotation: { filePath: "src/f.ts", startLine: 1, endLine: 1, body },
      }),
    ) as { annotationId: string };
    const listed = provider.invoke(
      invokeCall("listAnnotations", { threadId: "thread-a", include: ["text"] }),
    ) as { annotations: { text?: string; textTruncated?: boolean }[] };
    expect(listed.annotations[0]).toMatchObject({ textTruncated: true });
    expect(listed.annotations[0]!.text).toHaveLength(160);
    const read = (id: string, threadId = "thread-a") =>
      provider.invoke(invokeCall("getAnnotation", { threadId, annotationId: id }));
    const answer = read(annotationId);
    expect(answer).toEqual({ found: true, text: body });
    expect(new TextEncoder().encode(JSON.stringify(answer)).length).toBeLessThan(24_576 + 64);
    expect(read("annotation:ext.a:gone")).toEqual({ found: false });
    // Another installation's comment, another thread and no grant are refused.
    expectDenied(() => read("annotation:ext.b:x"));
    expectDenied(() => read(annotationId, "thread-b"));
    expectDenied(() =>
      createComposerClientProvider(makeDeps([])).invoke(
        invokeCall("getAnnotation", { threadId: "thread-a", annotationId }),
      ),
    );
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

describe("editor provider", () => {
  const EDITOR = ["t3.ui/editor.open"];
  const launcher = (availableEditors: readonly EditorId[], fail?: Error) => {
    const openInEditor = vi.fn(async (_value: unknown) =>
      fail ? AsyncResult.failure(Cause.fail(fail)) : AsyncResult.success(undefined),
    );
    return {
      availableEditors: () => availableEditors,
      openInEditor,
      remoteState: () =>
        resolveRemoteOpenState({
          target: null,
          sshAlias: null,
          remoteOpenTargets: undefined,
          isDesktopRenderer: false,
        }),
      remoteEditors: vi.fn(async () => [EditorId.make("vscode")]),
      openRemoteUrl: vi.fn(async (_url: string) => true),
    };
  };
  const openPath = (path: string) => invokeCall("openPath", { path, cwd: "/ws/root" });

  it.each([
    {
      name: "local",
      target: new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make(ENV),
        label: "local",
        httpBaseUrl: "http://127.0.0.1:8000",
        wsBaseUrl: "ws://127.0.0.1:8000",
      }),
      sshAlias: null,
      editor: EditorId.make("vscode"),
    },
    {
      name: "ssh-remote",
      target: new SshConnectionTarget({
        environmentId: EnvironmentId.make(ENV),
        label: "ssh",
        connectionId: "ssh-1",
      }),
      sshAlias: "dev alias",
      editor: EditorId.make("cursor"),
    },
    {
      name: "tunnel",
      target: new RelayConnectionTarget({
        environmentId: EnvironmentId.make(ENV),
        label: "tunnel",
      }),
      sshAlias: null,
      editor: EditorId.make("zed"),
    },
  ])("keeps native explicit-cwd execution for $name", async ({ target, sshAlias, editor }) => {
    const state = resolveRemoteOpenState({
      target,
      sshAlias,
      remoteOpenTargets: [
        { kind: "tailscale", host: "dev.tail.ts.net" },
        { kind: "mdns", host: "dev.local" },
      ],
      isDesktopRenderer: false,
    });
    const fake = {
      ...launcher([editor]),
      remoteState: () => state,
      remoteEditors: vi.fn(async () => [editor]),
    };
    setLocalStorageItem("t3code:last-editor", editor, EditorId);
    const result = await createEditorClientProvider(makeDeps(EDITOR), fake).invoke(
      openPath("src/my file.ts:3:5"),
    );
    const path = "/ws/root/src/my file.ts:3:5";
    expect(result).toEqual({ status: "opened", path, editor });
    expect(fake.openInEditor).toHaveBeenCalledWith({
      environmentId: ENV,
      input: { cwd: path, editor },
    });
    expect(fake.openRemoteUrl).not.toHaveBeenCalled();
    expect(fake.remoteEditors).not.toHaveBeenCalled();
  });

  it("uses the environment's editors for explicit-cwd calls even in remote mode", async () => {
    const fake = {
      ...launcher([EditorId.make("trae")]),
      remoteState: () => ({
        mode: "remote-links" as const,
        host: { kind: "ssh-alias" as const, host: "dev" },
      }),
    };
    setLocalStorageItem("t3code:last-editor", EditorId.make("trae"), EditorId);
    await expect(
      createEditorClientProvider(makeDeps(EDITOR), fake).invoke(openPath("file.ts")),
    ).resolves.toMatchObject({
      status: "opened",
      editor: "trae",
    });
    expect(getLocalStorageItem("t3code:last-editor", EditorId)).toBe("trae");
    expect(getLocalStorageItem("t3code:remote-open-hint-seen", Schema.Boolean)).toBeNull();
    expect(fake.openInEditor).toHaveBeenCalled();
  });

  it("keeps explicit-cwd execution when no SSH target was advertised", async () => {
    const fake = {
      ...launcher([EditorId.make("vscode")]),
      remoteState: () => ({ mode: "remote-unavailable" as const }),
    };
    await expect(
      createEditorClientProvider(makeDeps(EDITOR), fake).invoke(openPath("file.ts")),
    ).resolves.toMatchObject({ status: "opened", editor: "vscode" });
    expect(fake.openInEditor).toHaveBeenCalled();
    expect(fake.openRemoteUrl).not.toHaveBeenCalled();
  });

  it.each([false, new Error("shell refused")])(
    "does not use remote fallback editors for an explicit-cwd call (%s)",
    async (outcome) => {
      const fake = {
        ...launcher([]),
        remoteState: () => ({
          mode: "remote-links" as const,
          host: { kind: "ssh-alias" as const, host: "dev" },
        }),
        openRemoteUrl: vi.fn(async () => {
          if (outcome instanceof Error) throw outcome;
          return outcome;
        }),
      };
      setLocalStorageItem("t3code:last-editor", EditorId.make("trae"), EditorId);
      await expect(
        createEditorClientProvider(makeDeps(EDITOR), fake).invoke(openPath("file.ts")),
      ).resolves.toMatchObject({ status: "refused", reason: "no-editor" });
      expect(getLocalStorageItem("t3code:last-editor", EditorId)).toBe("trae");
      expect(getLocalStorageItem("t3code:remote-open-hint-seen", Schema.Boolean)).toBeNull();
      expect(fake.openInEditor).not.toHaveBeenCalled();
    },
  );

  it("rejects callers without the editor-open grant", async () => {
    const fake = launcher([EditorId.make("vscode")]);
    const provider = createEditorClientProvider(makeDeps(THEME_CAPS), fake);
    await expect(provider.invoke(openPath("src/app.ts"))).rejects.toMatchObject({
      code: "client-target-denied",
    });
    expect(fake.openInEditor).not.toHaveBeenCalled();
  });

  it("opens the resolved path and position in the user's saved editor, not the Files view", async () => {
    const fake = launcher([EditorId.make("cursor"), EditorId.make("zed")]);
    const provider = createEditorClientProvider(makeDeps(EDITOR), fake);
    const panels = useRightPanelStore.getState().byThreadKey;
    setLocalStorageItem("t3code:last-editor", EditorId.make("zed"), EditorId);
    await expect(provider.invoke(openPath("src/app.ts:3:5"))).resolves.toEqual({
      status: "opened",
      path: "/ws/root/src/app.ts:3:5",
      editor: "zed",
    });
    setLocalStorageItem("t3code:last-editor", EditorId.make("cursor"), EditorId);
    await provider.invoke(openPath("/elsewhere/worktree/b.ts:9"));
    expect(fake.openInEditor.mock.calls.map(([value]) => value)).toEqual([
      { environmentId: ENV, input: { cwd: "/ws/root/src/app.ts:3:5", editor: "zed" } },
      { environmentId: ENV, input: { cwd: "/elsewhere/worktree/b.ts:9", editor: "cursor" } },
    ]);
    expect(useRightPanelStore.getState().byThreadKey).toBe(panels);
  });

  it("reports a missing editor and a failed launch with the native wording", async () => {
    await expect(
      createEditorClientProvider(makeDeps(EDITOR), launcher([])).invoke(openPath("a.ts")),
    ).resolves.toEqual({
      status: "refused",
      reason: "no-editor",
      message: `No available editor can open /ws/root/a.ts in environment ${ENV}.`,
    });
    await expect(
      createEditorClientProvider(
        makeDeps(EDITOR),
        launcher([EditorId.make("vscode")], new Error("spawn code ENOENT")),
      ).invoke(openPath("a.ts")),
    ).resolves.toEqual({ status: "refused", reason: "open-failed", message: "spawn code ENOENT" });
  });
});

describe("external provider", () => {
  const EXTERNAL = ["t3.ui/external.open"];

  it("rejects callers without the external-open grant", async () => {
    const open = vi.fn(async () => {});
    const provider = createExternalClientProvider(makeDeps(THEME_CAPS), () => ({
      kind: "desktop-shell",
      open,
    }));
    await expect(
      provider.invoke(invokeCall("open", { url: "https://example.com" })),
    ).rejects.toMatchObject({ code: "client-target-denied" });
    expect(open).not.toHaveBeenCalled();
  });

  it("re-checks the URL and never hands a refused scheme to the opener", async () => {
    const open = vi.fn(async () => {});
    const provider = createExternalClientProvider(makeDeps(EXTERNAL), () => ({
      kind: "desktop-shell",
      open,
    }));
    await expect(
      provider.invoke(invokeCall("open", { url: "javascript:alert(1)" })),
    ).resolves.toEqual({ status: "refused", reason: "scheme-not-allowed" });
    await expect(provider.invoke(invokeCall("open", { url: "/relative" }))).resolves.toEqual({
      status: "refused",
      reason: "invalid-url",
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("opens through the desktop shell and reports a declined URL", async () => {
    const openExternal = vi.fn(async (url: string) => url.includes("example.com"));
    vi.stubGlobal("window", { desktopBridge: { openExternal }, open: vi.fn() });
    const provider = createExternalClientProvider(makeDeps(EXTERNAL));
    await expect(
      provider.invoke(invokeCall("open", { url: "https://example.com/a b" })),
    ).resolves.toEqual({
      status: "opened",
      url: "https://example.com/a%20b",
      opener: "desktop-shell",
    });
    expect(openExternal).toHaveBeenCalledWith("https://example.com/a%20b");
    await expect(
      provider.invoke(invokeCall("open", { url: "https://other.test/" })),
    ).resolves.toEqual({ status: "refused", reason: "opener-refused" });
  });

  it("opens a severed browser window on web and reports a blocked popup as refused", async () => {
    const clicked: { href: string; rel: string }[] = [];
    const popup = {
      opener: {} as unknown,
      document: {
        createElement: () => {
          const link = {
            href: "",
            rel: "",
            click: () => clicked.push({ href: link.href, rel: link.rel }),
          };
          return link;
        },
        body: { append: () => {} },
      },
    };
    let popupsAllowed = true;
    const open = vi.fn(() => (popupsAllowed ? popup : null));
    vi.stubGlobal("window", { open });
    const provider = createExternalClientProvider(makeDeps(EXTERNAL));
    await expect(
      provider.invoke(invokeCall("open", { url: "http://localhost:3000" })),
    ).resolves.toEqual({
      status: "opened",
      url: "http://localhost:3000/",
      opener: "browser-window",
    });
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(popup.opener).toBeNull();
    expect(clicked).toEqual([{ href: "http://localhost:3000/", rel: "noreferrer" }]);

    popupsAllowed = false;
    await expect(
      provider.invoke(invokeCall("open", { url: "http://localhost:3000" })),
    ).resolves.toEqual({ status: "refused", reason: "opener-refused" });
    expect(clicked).toHaveLength(1);
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

  it("resolves terminal fonts through the typography mode, like the native drawer", () => {
    const baseline = getClientSettings();
    __setClientSettingsForTests({
      ...baseline,
      fontFamilyCode: "Fira Code",
      fontSizeCode: 17,
      fontFamilyTerminal: "Courier New",
      fontSizeTerminal: 12,
    });
    try {
      const provider = createTerminalAppearanceClientProvider(makeDeps(["t3.ui/theme.read"]));
      const font = () =>
        (provider.invoke(invokeCall("getAppearance", {})) as { font: unknown }).font;
      // Simple typography: the terminal is another code surface.
      expect(font()).toEqual({ family: "Fira Code", size: 17 });
      window.localStorage.setItem("t3code:typography-advanced", "true");
      expect(font()).toEqual({ family: "Courier New", size: 12 });
    } finally {
      __setClientSettingsForTests(baseline);
    }
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
    const providers = createClientProviders(makeDeps([]), async () => {}, unusedPrHandoff);
    const denied = providers.get("t3.client/keybindings")!;
    expectDenied(() =>
      denied.invoke(
        invokeCall("registerCommands", {
          commands: [{ id: "run", title: "Run", scope: "surface" }],
        }),
      ),
    );
    const granted = createClientProviders(
      makeDeps(["t3.ui/keybindings"]),
      async () => {},
      unusedPrHandoff,
    ).get("t3.client/keybindings")!;
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
    window.localStorage.setItem("t3code:typography-advanced", "true");
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

it("registers every implemented client API at its shared SDK version", () => {
  const providers = createClientProviders(makeDeps([]), async () => {}, unusedPrHandoff);
  expect(CLIENT_PROVIDER_DESCRIPTORS.map(({ id }) => id).sort()).toEqual(
    [...providers.keys()].sort(),
  );
  expect(CLIENT_PROVIDER_DESCRIPTORS).toEqual(
    [...CLIENT_PROVIDER_APIS.values()].map(({ id, version }) => ({ id, version })),
  );
});
