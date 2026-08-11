import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { isValidElement, type EffectCallback, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import type {
  VoiceSupervisorConfirmation,
  VoiceSupervisorHostStartInput,
} from "../../voice/voiceSupervisorHost";
import { useVoicePanelStore } from "../../voice/voicePanelStore";

const effectHarness = vi.hoisted(() => {
  interface EffectSlot {
    readonly dependencies: ReadonlyArray<unknown> | undefined;
    setup: EffectCallback | null;
    cleanup: (() => void) | undefined;
  }

  let cursor = 0;
  let slots: EffectSlot[] = [];
  const dependenciesEqual = (
    left: ReadonlyArray<unknown> | undefined,
    right: ReadonlyArray<unknown> | undefined,
  ) =>
    left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));

  return {
    beginRender() {
      cursor = 0;
    },
    useEffect(setup: EffectCallback, dependencies?: ReadonlyArray<unknown>) {
      const index = cursor++;
      const previous = slots[index];
      if (previous && dependenciesEqual(previous.dependencies, dependencies)) return;
      previous?.cleanup?.();
      slots[index] = { dependencies, setup, cleanup: undefined };
    },
    flush() {
      for (const slot of slots) {
        if (!slot.setup) continue;
        const cleanup = slot.setup();
        slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
        slot.setup = null;
      }
    },
    reset() {
      for (const slot of slots) slot.cleanup?.();
      cursor = 0;
      slots = [];
    },
  };
});

const testState = vi.hoisted(() => {
  interface PanelState {
    readonly open: boolean;
    readonly openVoicePanel: () => void;
    readonly closeVoicePanel: () => void;
    readonly toggleVoicePanel: () => void;
  }

  return {
    panelOpen: false,
    panelListeners: new Set<(state: PanelState, previousState: PanelState) => void>(),
    environments: [] as ReadonlyArray<unknown>,
    primaryEnvironmentId: null as string | null,
    preparedById: new Map<string, unknown>(),
    snapshot: { confirmations: [] as ReadonlyArray<unknown> },
    voice: {
      generation: 0,
      phase: "idle",
      muted: false,
      sessionId: null,
      errorMessage: null as string | null,
      transcript: [] as ReadonlyArray<unknown>,
      activity: [] as ReadonlyArray<unknown>,
      beginSession: vi.fn(),
      markConnected: vi.fn(),
      setMuted: vi.fn(),
      ingestEvent: vi.fn(),
      failSession: vi.fn(),
      endSession: vi.fn(),
      reset: vi.fn(),
    },
    controller: {
      getSnapshot: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
      start: vi.fn((_input: VoiceSupervisorHostStartInput) => 1),
      stop: vi.fn(),
      setMuted: vi.fn(),
      confirm: vi.fn(),
      deny: vi.fn(),
      hostUnavailable: vi.fn(),
      dispose: vi.fn(),
    },
    prepareMicrophone: vi.fn(),
    readPreparedConnection: vi.fn(),
    readAuthoritativeVoiceHostConnection: vi.fn(),
    mintVoiceClientSecret: vi.fn(),
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: effectHarness.useEffect,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) =>
      reactHookHarness.useMemo(getSnapshot),
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ state: { matches: [] } }),
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: testState.environments }),
  usePrimaryEnvironmentId: () => testState.primaryEnvironmentId,
}));

vi.mock("../../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/session")>();
  return {
    ...actual,
    usePreparedConnection: (environmentId: string | null) => {
      const value = environmentId === null ? undefined : testState.preparedById.get(environmentId);
      return value === undefined ? Option.none() : Option.some(value);
    },
    readPreparedConnection: (environmentId: string) =>
      testState.readPreparedConnection(environmentId),
  };
});

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

vi.mock("@t3tools/client-runtime/state/voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime/state/voice")>();
  const Effect = await import("effect/Effect");
  return {
    ...actual,
    mintVoiceClientSecret: (input: unknown) => {
      testState.mintVoiceClientSecret(input);
      return Effect.succeed({
        clientSecret: "ek_test",
        expiresAt: 2_000_000_000,
        sessionId: "session-test",
      });
    },
  };
});

vi.mock("../../voice/voiceSupervisorHost", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../voice/voiceSupervisorHost")>();
  return {
    ...actual,
    createVoiceSupervisorHostController: () => testState.controller,
    createDefaultVoiceToolsController: vi.fn(),
  };
});

vi.mock("../../voice/voiceSupervisorStore", () => {
  const useVoiceSupervisorStore = Object.assign(
    (selector: (state: typeof testState.voice) => unknown) => selector(testState.voice),
    { getState: () => testState.voice },
  );
  return { useVoiceSupervisorStore };
});

vi.mock("../../voice/voicePanelStore", () => {
  const actions = {
    openVoicePanel: () => setOpen(true),
    closeVoicePanel: () => setOpen(false),
    toggleVoicePanel: () => setOpen(!testState.panelOpen),
  };
  const getState = () => ({ open: testState.panelOpen, ...actions });
  const setOpen = (open: boolean) => {
    if (open === testState.panelOpen) return;
    const previousState = getState();
    testState.panelOpen = open;
    const state = getState();
    for (const listener of testState.panelListeners) listener(state, previousState);
  };
  const useVoicePanelStore = Object.assign(
    (selector: (state: ReturnType<typeof getState>) => unknown) => selector(getState()),
    {
      getState,
      subscribe: (
        listener: (
          state: ReturnType<typeof getState>,
          previousState: ReturnType<typeof getState>,
        ) => void,
      ) => {
        testState.panelListeners.add(listener);
        return () => testState.panelListeners.delete(listener);
      },
    },
  );
  return { useVoicePanelStore };
});

vi.mock("./VoiceSupervisorHost.logic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./VoiceSupervisorHost.logic")>();
  return {
    ...actual,
    prepareDesktopMicrophoneAccess: () => testState.prepareMicrophone(),
    readAuthoritativeVoiceHostConnection: (environmentId: string) =>
      testState.readAuthoritativeVoiceHostConnection(environmentId),
  };
});

import type { EnvironmentPresentation } from "../../state/environments";
import { Button } from "../ui/button";
import { ConfirmationCard, VoiceSupervisorHost, VoiceSupervisorPanel } from "./VoiceSupervisorHost";

interface Deferred<A> {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
}

function deferred<A>(): Deferred<A> {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function environment(
  environmentId: EnvironmentId,
  label: string,
  options: { readonly connected?: boolean; readonly supportsVoice?: boolean } = {},
): EnvironmentPresentation {
  return {
    environmentId,
    label,
    displayUrl: `https://${String(environmentId)}.example.test`,
    relayManaged: false,
    entry: {
      target: {
        _tag: "PrimaryConnectionTarget",
        environmentId,
        label,
        httpBaseUrl: `https://${String(environmentId)}.example.test`,
        wsBaseUrl: `wss://${String(environmentId)}.example.test`,
      },
    },
    connection: {
      phase: options.connected === false ? "offline" : "connected",
      error: null,
      traceId: null,
    },
    serverConfig: {
      environment: { capabilities: { realtimeVoice: options.supportsVoice ?? true } },
    },
  } as EnvironmentPresentation;
}

function prepared(environmentId: EnvironmentId, label: string): PreparedConnection {
  return {
    environmentId,
    label,
    httpBaseUrl: `https://${String(environmentId)}.example.test`,
    socketUrl: `wss://${String(environmentId)}.example.test/ws`,
    httpAuthorization: null,
    target: {
      _tag: "PrimaryConnectionTarget",
      environmentId,
      label,
      httpBaseUrl: `https://${String(environmentId)}.example.test`,
      wsBaseUrl: `wss://${String(environmentId)}.example.test`,
    },
  };
}

function collectElements(
  node: unknown,
  visitor: (element: ReactElement<Record<string, unknown>>) => boolean,
  output: Array<ReactElement<Record<string, unknown>>> = [],
): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, visitor, output);
    return output;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return output;
  if (visitor(node)) output.push(node);
  for (const value of Object.values(node.props)) collectElements(value, visitor, output);
  return output;
}

function beginRender() {
  hooks.beginRender();
  effectHarness.beginRender();
}

function renderHost() {
  beginRender();
  const result = VoiceSupervisorHost() as ReactElement<Record<string, unknown>>;
  effectHarness.flush();
  return result;
}

function findLauncher(host: ReactElement<Record<string, unknown>>) {
  const launcher = collectElements(
    host,
    (element) =>
      element.type === Button && element.props["aria-controls"] === "voice-supervisor-panel",
  )[0];
  if (launcher === undefined) throw new Error("Expected the voice launcher.");
  return launcher;
}

function findPanel(host: ReactElement<Record<string, unknown>>) {
  const panel = collectElements(host, (element) => element.type === VoiceSupervisorPanel)[0];
  if (panel === undefined) throw new Error("Expected the voice panel.");
  return panel as ReactElement<Parameters<typeof VoiceSupervisorPanel>[0]>;
}

function assignRef(element: ReactElement<Record<string, unknown>>, value: unknown) {
  const ref = element.props.ref;
  if (ref === null || typeof ref !== "object" || !("current" in ref)) {
    throw new Error("Expected an object ref.");
  }
  ref.current = value;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

const PRIMARY_ID = EnvironmentId.make("primary");
const REMOTE_ID = EnvironmentId.make("remote");

beforeEach(() => {
  effectHarness.reset();
  hooks.reset();
  useVoicePanelStore.getState().closeVoicePanel();
  vi.clearAllMocks();
  const primary = environment(PRIMARY_ID, "Laptop");
  testState.environments = [primary];
  testState.primaryEnvironmentId = PRIMARY_ID;
  testState.preparedById.clear();
  testState.preparedById.set(PRIMARY_ID, prepared(PRIMARY_ID, "Laptop"));
  testState.readPreparedConnection.mockImplementation((environmentId: string) =>
    testState.preparedById.get(environmentId),
  );
  testState.readAuthoritativeVoiceHostConnection.mockImplementation((environmentId: string) =>
    testState.preparedById.get(environmentId),
  );
  testState.snapshot = { confirmations: [] };
  testState.controller.getSnapshot.mockImplementation(() => testState.snapshot);
  testState.prepareMicrophone.mockResolvedValue({ status: "ready" });
  Object.assign(testState.voice, {
    generation: 0,
    phase: "idle",
    muted: false,
    sessionId: null,
    errorMessage: null,
    transcript: [],
    activity: [],
  });
  vi.stubGlobal("window", { desktopBridge: undefined });
});

afterEach(() => {
  effectHarness.reset();
  vi.unstubAllGlobals();
});

describe("voice supervisor host interactions", () => {
  it("renders the singleton panel opened by another entry point without starting anything", () => {
    let host = renderHost();
    expect(findLauncher(host).props["aria-pressed"]).toBe(false);
    useVoicePanelStore.getState().openVoicePanel();

    host = renderHost();
    expect(findLauncher(host).props["aria-pressed"]).toBe(true);
    expect(collectElements(host, (element) => element.type === VoiceSupervisorPanel)).toHaveLength(
      1,
    );
    expect(testState.prepareMicrophone).not.toHaveBeenCalled();
    expect(testState.controller.start).not.toHaveBeenCalled();

    useVoicePanelStore.getState().toggleVoicePanel();
    host = renderHost();
    expect(findLauncher(host).props["aria-pressed"]).toBe(false);
    expect(collectElements(host, (element) => element.type === VoiceSupervisorPanel)).toHaveLength(
      0,
    );
  });

  it("resets an open singleton panel on unmount so a remount stays closed", () => {
    renderHost();
    useVoicePanelStore.getState().openVoicePanel();
    let host = renderHost();
    expect(findLauncher(host).props["aria-pressed"]).toBe(true);
    expect(findPanel(host)).toBeDefined();

    effectHarness.reset();
    expect(useVoicePanelStore.getState().open).toBe(false);

    hooks.reset();
    host = renderHost();
    expect(findLauncher(host).props["aria-pressed"]).toBe(false);
    expect(collectElements(host, (element) => element.type === VoiceSupervisorPanel)).toHaveLength(
      0,
    );
  });

  it("opens without touching the microphone and starts only after the explicit Start action", async () => {
    const permission = deferred<{ readonly status: "ready" }>();
    testState.prepareMicrophone.mockReturnValueOnce(permission.promise);
    renderHost();
    let host = renderHost();
    const launcher = findLauncher(host);
    (launcher.props.onClick as () => void)();
    host = renderHost();
    expect(testState.prepareMicrophone).not.toHaveBeenCalled();
    expect(testState.controller.start).not.toHaveBeenCalled();

    const panel = findPanel(host);
    const audio = collectElements(host, (element) => element.type === "audio")[0];
    if (audio === undefined) throw new Error("Expected hidden audio.");
    assignRef(audio, {});
    const pending = (panel.props.onStart as () => Promise<void>)();
    const postDesktopPreflightPrepared = prepared(PRIMARY_ID, "Laptop refreshed");
    testState.preparedById.set(PRIMARY_ID, postDesktopPreflightPrepared);
    permission.resolve({ status: "ready" });
    await pending;
    expect(testState.prepareMicrophone).toHaveBeenCalledOnce();
    expect(testState.readAuthoritativeVoiceHostConnection).toHaveBeenCalledWith(PRIMARY_ID);
    expect(testState.controller.start).toHaveBeenCalledWith(
      expect.objectContaining({ audioElement: {}, voice: "marin" }),
    );
    const startInput = testState.controller.start.mock.calls[0]?.[0];
    if (startInput === undefined) throw new Error("Expected a voice start input.");
    const postBrowserPermissionPrepared = prepared(PRIMARY_ID, "Laptop rotated credential");
    testState.preparedById.set(PRIMARY_ID, postBrowserPermissionPrepared);
    await startInput.getClientSecret(new AbortController().signal);
    expect(testState.mintVoiceClientSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        prepared: postBrowserPermissionPrepared,
        request: { voice: "marin" },
      }),
    );
  });

  it("fails credential minting safely when host authority disappears during browser permission", async () => {
    renderHost();
    let host = renderHost();
    (findLauncher(host).props.onClick as () => void)();
    host = renderHost();
    const panel = findPanel(host);
    const audio = collectElements(host, (element) => element.type === "audio")[0];
    if (audio === undefined) throw new Error("Expected hidden audio.");
    assignRef(audio, {});
    await (panel.props.onStart as () => Promise<void>)();
    const startInput = testState.controller.start.mock.calls[0]?.[0];
    if (startInput === undefined) throw new Error("Expected a voice start input.");

    testState.readAuthoritativeVoiceHostConnection.mockReturnValue(null);
    await expect(startInput.getClientSecret(new AbortController().signal)).rejects.toMatchObject({
      reason: "client_secret_failed",
      message: "T3 Code could not start a voice session.",
    });
    expect(testState.mintVoiceClientSecret).not.toHaveBeenCalled();
  });

  it("invalidates permission work on close and restores focus to the launcher", async () => {
    const permission = deferred<{ readonly status: "ready" }>();
    testState.prepareMicrophone.mockReturnValueOnce(permission.promise);
    renderHost();
    let host = renderHost();
    const launcher = findLauncher(host);
    const focus = vi.fn();
    assignRef(launcher, { focus });
    (launcher.props.onClick as () => void)();
    host = renderHost();
    const panel = findPanel(host);
    const audio = collectElements(host, (element) => element.type === "audio")[0];
    if (audio === undefined) throw new Error("Expected hidden audio.");
    assignRef(audio, {});
    const pending = (panel.props.onStart as () => Promise<void>)();
    panel.props.onClose();
    permission.resolve({ status: "ready" });
    await pending;
    expect(testState.controller.start).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("invalidates permission work on environment, voice, capability, and prepared changes", async () => {
    const scenarios: Array<(panel: Parameters<typeof VoiceSupervisorPanel>[0]) => void> = [
      (panel) => panel.onSelectEnvironment(REMOTE_ID),
      (panel) => panel.onSelectVoice("cedar"),
      () => {
        testState.environments = [
          environment(PRIMARY_ID, "Laptop", { supportsVoice: false }),
          environment(REMOTE_ID, "Remote"),
        ];
        renderHost();
      },
      () => {
        testState.preparedById.delete(PRIMARY_ID);
        renderHost();
      },
    ];

    for (const invalidate of scenarios) {
      effectHarness.reset();
      hooks.reset();
      useVoicePanelStore.getState().closeVoicePanel();
      vi.clearAllMocks();
      testState.environments = [
        environment(PRIMARY_ID, "Laptop"),
        environment(REMOTE_ID, "Remote"),
      ];
      testState.primaryEnvironmentId = PRIMARY_ID;
      testState.preparedById.set(PRIMARY_ID, prepared(PRIMARY_ID, "Laptop"));
      testState.preparedById.set(REMOTE_ID, prepared(REMOTE_ID, "Remote"));
      testState.controller.getSnapshot.mockImplementation(() => testState.snapshot);
      const permission = deferred<{ readonly status: "ready" }>();
      testState.prepareMicrophone.mockReturnValueOnce(permission.promise);
      renderHost();
      let host = renderHost();
      (findLauncher(host).props.onClick as () => void)();
      host = renderHost();
      const panel = findPanel(host);
      const audio = collectElements(host, (element) => element.type === "audio")[0];
      if (audio === undefined) throw new Error("Expected hidden audio.");
      assignRef(audio, {});
      const pending = (panel.props.onStart as () => Promise<void>)();
      invalidate(panel.props);
      permission.resolve({ status: "ready" });
      await pending;
      await flushPromises();
      expect(testState.controller.start).not.toHaveBeenCalled();
    }
  });

  it("revalidates authoritative host atoms after permission without requiring a rerender", async () => {
    const permission = deferred<{ readonly status: "ready" }>();
    testState.prepareMicrophone.mockReturnValueOnce(permission.promise);
    renderHost();
    let host = renderHost();
    (findLauncher(host).props.onClick as () => void)();
    host = renderHost();
    const panel = findPanel(host);
    const audio = collectElements(host, (element) => element.type === "audio")[0];
    if (audio === undefined) throw new Error("Expected hidden audio.");
    assignRef(audio, {});
    const pending = (panel.props.onStart as () => Promise<void>)();

    testState.readAuthoritativeVoiceHostConnection.mockReturnValue(null);
    permission.resolve({ status: "ready" });
    await pending;

    expect(testState.readAuthoritativeVoiceHostConnection).toHaveBeenCalledWith(PRIMARY_ID);
    expect(testState.controller.start).not.toHaveBeenCalled();
  });

  it("invalidates permission work and disposes the singleton controller on unmount", async () => {
    const permission = deferred<{ readonly status: "ready" }>();
    testState.prepareMicrophone.mockReturnValueOnce(permission.promise);
    renderHost();
    let host = renderHost();
    (findLauncher(host).props.onClick as () => void)();
    host = renderHost();
    const panel = findPanel(host);
    const audio = collectElements(host, (element) => element.type === "audio")[0];
    if (audio === undefined) throw new Error("Expected hidden audio.");
    assignRef(audio, {});
    const pending = (panel.props.onStart as () => Promise<void>)();
    effectHarness.reset();
    permission.resolve({ status: "ready" });
    await pending;
    expect(testState.controller.dispose).toHaveBeenCalledOnce();
    expect(testState.controller.start).not.toHaveBeenCalled();
  });

  it("keeps hidden active and pending states statically visible and accessible", () => {
    renderHost();
    let host = renderHost();
    expect(findLauncher(host).props["aria-label"]).toContain("voice session idle");

    testState.voice.phase = "connecting";
    host = renderHost();
    expect(findLauncher(host).props["aria-label"]).toContain("connecting; microphone muted");

    testState.voice.phase = "connected";
    testState.voice.muted = false;
    host = renderHost();
    expect(findLauncher(host).props["aria-label"]).toContain("microphone listening");

    testState.voice.muted = true;
    host = renderHost();
    expect(findLauncher(host).props["aria-label"]).toContain("microphone muted");

    testState.voice.phase = "failed";
    testState.voice.muted = false;
    host = renderHost();
    expect(findLauncher(host).props["aria-label"]).toContain("voice session failed");

    testState.snapshot = {
      confirmations: [
        {
          generation: 1,
          callId: "call-1",
          action: "Interrupt thread",
          summary: "Interrupt Fix voice · Laptop",
          preview: {
            operation: "interrupt_thread",
            target: "Fix voice · Laptop",
            hasActiveTurn: true,
          },
        },
      ],
    };
    host = renderHost();
    const launcher = findLauncher(host);
    expect(launcher.props["aria-label"]).toContain("1 voice confirmation pending");
    const hiddenAnnouncement = collectElements(
      host,
      (element) => element.props.role === "status" && element.props["aria-live"] === "polite",
    )[0];
    expect(JSON.stringify(hiddenAnnouncement?.props.children)).toContain(
      "Interrupt Fix voice · Laptop",
    );
    expect(JSON.stringify(launcher.props)).not.toContain("animate");
  });

  it("shows a new microphone preflight error over an older session failure", () => {
    hooks.reset();
    effectHarness.reset();
    testState.voice.errorMessage = "Older session failure";
    beginRender();
    const panel = VoiceSupervisorPanel({
      environments: [environment(PRIMARY_ID, "Laptop")],
      selectedEnvironmentId: PRIMARY_ID,
      selectedAvailability: { kind: "ready" },
      selectedVoice: "marin",
      confirmations: [],
      startError: "Latest microphone permission failure",
      startPending: false,
      onClose: vi.fn(),
      onSelectEnvironment: vi.fn(),
      onSelectVoice: vi.fn(),
      onStart: vi.fn(),
      onStop: vi.fn(),
      onSetMuted: vi.fn(),
      onConfirm: vi.fn(),
      onDeny: vi.fn(),
    }) as ReactElement<Record<string, unknown>>;
    const alert = collectElements(panel, (element) => element.props.role === "alert")[0];
    expect(alert?.props.children).toBe("Latest microphone permission failure");
  });

  it("focuses the non-modal panel and consumes descendant Escape to close", () => {
    hooks.reset();
    effectHarness.reset();
    beginRender();
    const onClose = vi.fn();
    const panel = VoiceSupervisorPanel({
      environments: [environment(PRIMARY_ID, "Laptop")],
      selectedEnvironmentId: PRIMARY_ID,
      selectedAvailability: { kind: "ready" },
      selectedVoice: "marin",
      confirmations: [],
      startError: null,
      startPending: false,
      onClose,
      onSelectEnvironment: vi.fn(),
      onSelectVoice: vi.fn(),
      onStart: vi.fn(),
      onStop: vi.fn(),
      onSetMuted: vi.fn(),
      onConfirm: vi.fn(),
      onDeny: vi.fn(),
    }) as ReactElement<Record<string, unknown>>;
    const focus = vi.fn();
    assignRef(panel, { focus });
    effectHarness.flush();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    const event = {
      key: "Escape",
      target: {},
      currentTarget: {},
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    (panel.props.onKeyDown as (input: typeof event) => void)(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not let panel focus steal focus from a pending confirmation", () => {
    hooks.reset();
    effectHarness.reset();
    beginRender();
    const panel = VoiceSupervisorPanel({
      environments: [environment(PRIMARY_ID, "Laptop")],
      selectedEnvironmentId: PRIMARY_ID,
      selectedAvailability: { kind: "ready" },
      selectedVoice: "marin",
      confirmations: [
        {
          generation: 1,
          callId: "pending-call",
          action: "Interrupt thread",
          summary: "Interrupt Fix voice · Laptop",
          preview: {
            operation: "interrupt_thread",
            target: "Fix voice · Laptop",
            hasActiveTurn: true,
          },
        },
      ],
      startError: null,
      startPending: false,
      onClose: vi.fn(),
      onSelectEnvironment: vi.fn(),
      onSelectVoice: vi.fn(),
      onStart: vi.fn(),
      onStop: vi.fn(),
      onSetMuted: vi.fn(),
      onConfirm: vi.fn(),
      onDeny: vi.fn(),
    }) as ReactElement<Record<string, unknown>>;
    const focus = vi.fn();
    assignRef(panel, { focus });
    effectHarness.flush();
    expect(focus).not.toHaveBeenCalled();
  });

  it("focuses a new confirmation and Escape from either button denies without closing", () => {
    hooks.reset();
    effectHarness.reset();
    const confirmation: VoiceSupervisorConfirmation = {
      generation: 1,
      callId: "call-1",
      action: "Start thread",
      summary: "Start Voice task in T3 · Laptop",
      preview: {
        operation: "start_thread",
        instruction: "Implement voice",
        target: "T3 · Laptop",
        title: "Voice task",
        model: "gpt-5.4",
        runtimeMode: "full-access",
        interactionMode: "default",
        workspace: {
          mode: "worktree",
          baseBranch: "main",
          startFromOrigin: true,
          runSetupScript: true,
        },
      },
    };
    beginRender();
    const onDeny = vi.fn();
    const card = ConfirmationCard({ confirmation, onConfirm: vi.fn(), onDeny }) as ReactElement<
      Record<string, unknown>
    >;
    const focus = vi.fn();
    assignRef(card, { focus });
    effectHarness.flush();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(
      collectElements(card, (element) => element.props.role === "status").some((element) =>
        JSON.stringify(element.props.children).includes("Start Voice task in T3 · Laptop"),
      ),
    ).toBe(true);
    expect(JSON.stringify(card)).toContain("T3 · Laptop");
    expect(JSON.stringify(card)).not.toContain("environment-test");
    const event = {
      key: "Escape",
      target: { tagName: "BUTTON" },
      currentTarget: { tagName: "ARTICLE" },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    (card.props.onKeyDown as (input: typeof event) => void)(event);
    expect(onDeny).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });
});
