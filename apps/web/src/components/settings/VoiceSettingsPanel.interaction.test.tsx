import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  AuthAccessWriteScope,
  EnvironmentId,
  type VoiceCredentialStatus,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";

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

const environmentState = vi.hoisted(() => ({
  environments: [] as ReadonlyArray<unknown>,
  isReady: true,
  primaryEnvironmentId: null as EnvironmentId | null,
  preparedById: new Map<EnvironmentId, unknown>(),
  session: {
    data: null as {
      readonly authenticated: boolean;
      readonly scopes?: ReadonlyArray<string>;
    } | null,
    hasError: false,
    isPending: false,
  },
}));

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
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../lib/runtime", () => ({
  runtime: { runPromise: vi.fn() },
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: environmentState.environments,
    isReady: environmentState.isReady,
    networkStatus: "online",
    presentationById: new Map(),
  }),
  usePrimaryEnvironmentId: () => environmentState.primaryEnvironmentId,
}));

vi.mock("../../state/session", () => ({
  usePreparedConnection: (environmentId: EnvironmentId) =>
    environmentState.preparedById.get(environmentId) ?? Option.none(),
  useEnvironmentSessionState: () => environmentState.session,
}));

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";
import {
  ConnectedVoiceCredentialSettings,
  SelectedVoiceEnvironmentSettings,
  VoiceCredentialEditor,
  VoiceEnvironmentPicker,
  VoiceSettingsPanel,
  type VoiceCredentialApi,
} from "./VoiceSettingsPanel";

interface Deferred<A> {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<A>(): Deferred<A> {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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

function environment(
  environmentId: EnvironmentId,
  label: string,
  options: {
    readonly connectionPhase?: "connected" | "offline";
    readonly hasServerConfig?: boolean;
    readonly supportsVoice?: boolean;
  } = {},
) {
  const hasServerConfig = options.hasServerConfig ?? true;
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
      phase: options.connectionPhase ?? "connected",
      error: null,
      traceId: null,
    },
    serverConfig: hasServerConfig
      ? { environment: { capabilities: { realtimeVoice: options.supportsVoice ?? true } } }
      : null,
  } as Parameters<typeof SelectedVoiceEnvironmentSettings>[0]["environment"];
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

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!isValidElement<Record<string, unknown>>(node)) return "";
  return textContent(node.props.children as ReactNode);
}

function beginRender(): void {
  hooks.beginRender();
  effectHarness.beginRender();
}

function renderConnected(
  environmentValue: ReturnType<typeof environment>,
  preparedValue: PreparedConnection,
  credentialApi: VoiceCredentialApi,
) {
  beginRender();
  const result = ConnectedVoiceCredentialSettings({
    environment: environmentValue,
    prepared: preparedValue,
    credentialApi,
  }) as ReactElement<Parameters<typeof VoiceCredentialEditor>[0]>;
  effectHarness.flush();
  return result;
}

function renderEditor(
  element: ReactElement<Parameters<typeof VoiceCredentialEditor>[0]>,
): ReactElement<Record<string, unknown>> {
  return VoiceCredentialEditor(element.props) as ReactElement<Record<string, unknown>>;
}

function apiWithStatus(status: VoiceCredentialStatus): VoiceCredentialApi {
  return {
    status: vi.fn(async () => status),
    update: vi.fn(async () => status),
  };
}

beforeEach(() => {
  effectHarness.reset();
  hooks.reset();
  environmentState.environments = [];
  environmentState.isReady = true;
  environmentState.primaryEnvironmentId = null;
  environmentState.preparedById.clear();
  environmentState.session = {
    data: { authenticated: true, scopes: [AuthAccessWriteScope] },
    hasError: false,
    isPending: false,
  };
});

afterEach(() => {
  effectHarness.reset();
});

describe("voice settings interactions", () => {
  it("changes the explicit voice-host environment selection", () => {
    const primaryId = EnvironmentId.make("primary");
    const remoteId = EnvironmentId.make("remote");
    const primary = environment(primaryId, "This device");
    const remote = environment(remoteId, "Remote device");
    environmentState.environments = [remote, primary];
    environmentState.primaryEnvironmentId = primaryId;

    beginRender();
    let panel = VoiceSettingsPanel({
      credentialApi: apiWithStatus({ configured: false, source: null }),
    });
    let picker = collectElements(panel, (element) => element.type === VoiceEnvironmentPicker)[0]!;
    expect(picker.props.selectedEnvironmentId).toBe(primaryId);

    const pickerSurface = VoiceEnvironmentPicker(
      picker.props as Parameters<typeof VoiceEnvironmentPicker>[0],
    );
    const buttons = collectElements(
      pickerSurface,
      (element) => element.type === "button" && typeof element.props.onClick === "function",
    );
    const remoteButton = buttons.find((button) => textContent(button).includes("Remote device"));
    expect(remoteButton).toBeDefined();
    (remoteButton!.props.onClick as () => void)();

    beginRender();
    panel = VoiceSettingsPanel({
      credentialApi: apiWithStatus({ configured: false, source: null }),
    });
    picker = collectElements(panel, (element) => element.type === VoiceEnvironmentPicker)[0]!;
    const selected = collectElements(
      panel,
      (element) => element.type === SelectedVoiceEnvironmentSettings,
    )[0]!;
    expect(picker.props.selectedEnvironmentId).toBe(remoteId);
    expect((selected.props.environment as ReturnType<typeof environment>).environmentId).toBe(
      remoteId,
    );
  });

  it("does not probe unsupported environments and labels capability preparation as loading", () => {
    const environmentId = EnvironmentId.make("host");
    const preparedValue = prepared(environmentId, "Host");
    environmentState.preparedById.set(environmentId, Option.some(preparedValue));
    const credentialApi = apiWithStatus({ configured: false, source: null });

    const unsupported = SelectedVoiceEnvironmentSettings({
      environment: environment(environmentId, "Host", { supportsVoice: false }),
      credentialApi,
    });
    expect(
      collectElements(unsupported, (element) => element.type === SettingsRow)[0]?.props.title,
    ).toBe("Voice is unsupported");
    expect(credentialApi.status).not.toHaveBeenCalled();

    const noConfig = SelectedVoiceEnvironmentSettings({
      environment: environment(environmentId, "Host", { hasServerConfig: false }),
      credentialApi,
    });
    expect(
      collectElements(noConfig, (element) => element.type === SettingsRow)[0]?.props.title,
    ).toBe("Loading voice settings");

    environmentState.preparedById.set(environmentId, Option.none());
    const noPreparedConnection = SelectedVoiceEnvironmentSettings({
      environment: environment(environmentId, "Host"),
      credentialApi,
    });
    expect(
      collectElements(noPreparedConnection, (element) => element.type === SettingsRow)[0]?.props
        .title,
    ).toBe("Loading voice settings");
    expect(credentialApi.status).not.toHaveBeenCalled();
  });

  it("fetches status, sets and removes credentials, reveals fallback, and restores focus", async () => {
    const environmentId = EnvironmentId.make("host");
    const environmentValue = environment(environmentId, "Host");
    const preparedValue = prepared(environmentId, "Host");
    const statusRequest = deferred<VoiceCredentialStatus>();
    const setRequest = deferred<VoiceCredentialStatus>();
    const removeRequest = deferred<VoiceCredentialStatus>();
    const credentialApi: VoiceCredentialApi = {
      status: vi.fn(() => statusRequest.promise),
      update: vi
        .fn()
        .mockImplementationOnce(() => setRequest.promise)
        .mockImplementationOnce(() => removeRequest.promise),
    };

    let editor = renderConnected(environmentValue, preparedValue, credentialApi);
    expect(credentialApi.status).toHaveBeenCalledTimes(1);
    statusRequest.resolve({ configured: false, source: null });
    await flushPromises();
    editor = renderConnected(environmentValue, preparedValue, credentialApi);
    expect(editor.props.loadState).toEqual({
      kind: "ready",
      status: { configured: false, source: null },
    });

    let editorSurface = renderEditor(editor);
    const input = collectElements(editorSurface, (element) => element.type === Input)[0]!;
    (input.props.onChange as (event: { currentTarget: { value: string } }) => void)({
      currentTarget: { value: "  sk-set-value  " },
    });
    editor = renderConnected(environmentValue, preparedValue, credentialApi);
    editorSurface = renderEditor(editor);
    const form = collectElements(editorSurface, (element) => element.type === "form")[0]!;
    (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({
      preventDefault: vi.fn(),
    });
    expect(credentialApi.update).toHaveBeenNthCalledWith(
      1,
      preparedValue,
      { action: "set", apiKey: "sk-set-value" },
      expect.any(AbortSignal),
    );
    editor = renderConnected(environmentValue, preparedValue, credentialApi);
    expect(editor.props.mutationAction).toBe("set");
    expect(textContent(renderEditor(editor))).toContain("Saving…");

    setRequest.resolve({ configured: true, source: "stored" });
    await flushPromises();
    editor = renderConnected(environmentValue, preparedValue, credentialApi);
    expect(editor.props.apiKey).toBe("");
    expect(editor.props.notice).toBe("OpenAI API key saved.");

    editor.props.onApiKeyChange("sk-must-clear-on-remove");
    editor = renderConnected(environmentValue, preparedValue, credentialApi);
    const focus = vi.fn();
    const inputRef = editor.props.apiKeyInputRef as {
      current: { focus: (options: FocusOptions) => void } | null;
    };
    inputRef.current = { focus };
    editorSurface = renderEditor(editor);
    const removeButton = collectElements(
      editorSurface,
      (element) => element.type === Button && textContent(element) === "Remove stored key",
    )[0]!;
    (removeButton.props.onClick as () => void)();
    expect(credentialApi.update).toHaveBeenNthCalledWith(
      2,
      preparedValue,
      { action: "remove" },
      expect.any(AbortSignal),
    );

    editor = renderConnected(environmentValue, preparedValue, credentialApi);
    expect(editor.props.mutationAction).toBe("remove");
    editorSurface = renderEditor(editor);
    expect(textContent(editorSurface)).toContain("Removing…");
    expect(textContent(editorSurface)).not.toContain("Saving…");

    removeRequest.resolve({ configured: true, source: "environment" });
    await flushPromises();
    expect(focus).not.toHaveBeenCalled();
    editor = renderConnected(environmentValue, preparedValue, credentialApi);
    expect(editor.props.apiKey).toBe("");
    expect(editor.props.notice).toBe(
      "Stored key removed. This environment is now using OPENAI_API_KEY from its host.",
    );
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("cancels a pending remove focus handoff when the environment surface unmounts", async () => {
    const environmentId = EnvironmentId.make("host");
    const environmentValue = environment(environmentId, "Host");
    const preparedValue = prepared(environmentId, "Host");
    const statusRequest = deferred<VoiceCredentialStatus>();
    const removeRequest = deferred<VoiceCredentialStatus>();
    const credentialApi: VoiceCredentialApi = {
      status: vi.fn(() => statusRequest.promise),
      update: vi.fn(() => removeRequest.promise),
    };

    let editor = renderConnected(environmentValue, preparedValue, credentialApi);
    statusRequest.resolve({ configured: true, source: "stored" });
    await flushPromises();
    editor = renderConnected(environmentValue, preparedValue, credentialApi);
    const focus = vi.fn();
    const inputRef = editor.props.apiKeyInputRef as {
      current: { focus: (options: FocusOptions) => void } | null;
    };
    inputRef.current = { focus };
    editor.props.onRemove();

    effectHarness.reset();
    removeRequest.resolve({ configured: false, source: null });
    await flushPromises();
    expect(focus).not.toHaveBeenCalled();
  });

  it("aborts an obsolete status request and ignores its stale result", async () => {
    const environmentId = EnvironmentId.make("host");
    const environmentValue = environment(environmentId, "Host");
    const firstPrepared = prepared(environmentId, "Host A");
    const secondPrepared = { ...prepared(environmentId, "Host B"), httpBaseUrl: "https://b.test" };
    const first = deferred<VoiceCredentialStatus>();
    const second = deferred<VoiceCredentialStatus>();
    const credentialApi: VoiceCredentialApi = {
      status: vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
      update: vi.fn(),
    };

    renderConnected(environmentValue, firstPrepared, credentialApi);
    let editor = renderConnected(environmentValue, secondPrepared, credentialApi);
    const firstSignal = vi.mocked(credentialApi.status).mock.calls[0]?.[1];
    expect(firstSignal?.aborted).toBe(true);

    first.resolve({ configured: true, source: "stored" });
    await flushPromises();
    second.resolve({ configured: false, source: null });
    await flushPromises();
    editor = renderConnected(environmentValue, secondPrepared, credentialApi);
    expect(editor.props.loadState).toEqual({
      kind: "ready",
      status: { configured: false, source: null },
    });
  });

  it("turns authoritative unknown-scope denial read-only but keeps transient errors retryable", async () => {
    const environmentId = EnvironmentId.make("host");
    const environmentValue = environment(environmentId, "Host");
    const preparedValue = prepared(environmentId, "Host");
    environmentState.session = {
      data: { authenticated: true },
      hasError: false,
      isPending: false,
    };
    const denied = deferred<VoiceCredentialStatus>();
    const deniedApi: VoiceCredentialApi = {
      status: vi.fn(() => denied.promise),
      update: vi.fn(),
    };

    let editor = renderConnected(environmentValue, preparedValue, deniedApi);
    expect(editor.props.writeAccess).toBe("unknown");
    const deniedDraft = "sk-clear-when-status-denies";
    editor.props.onApiKeyChange(deniedDraft);
    editor = renderConnected(environmentValue, preparedValue, deniedApi);
    expect(editor.props.apiKey).toBe(deniedDraft);
    denied.reject({ _tag: "EnvironmentScopeRequiredError", requiredScope: "access:write" });
    await flushPromises();
    editor = renderConnected(environmentValue, preparedValue, deniedApi);
    expect(editor.props.writeAccess).toBe("denied");
    expect(editor.props.apiKey).toBe("");
    const deniedSurface = renderEditor(editor);
    expect(JSON.stringify(deniedSurface.props)).not.toContain(deniedDraft);
    expect(
      collectElements(deniedSurface, (element) => element.type === Input)[0]?.props.disabled,
    ).toBe(true);
    expect(deniedApi.status).toHaveBeenCalledTimes(1);

    effectHarness.reset();
    hooks.reset();
    const transient = deferred<VoiceCredentialStatus>();
    const retry = deferred<VoiceCredentialStatus>();
    const transientApi: VoiceCredentialApi = {
      status: vi
        .fn()
        .mockImplementationOnce(() => transient.promise)
        .mockImplementationOnce(() => retry.promise),
      update: vi.fn(),
    };
    editor = renderConnected(environmentValue, preparedValue, transientApi);
    const transientDraft = "sk-preserve-for-transient-retry";
    editor.props.onApiKeyChange(transientDraft);
    editor = renderConnected(environmentValue, preparedValue, transientApi);
    transient.reject({ _tag: "RemoteEnvironmentAuthFetchError", message: "redacted" });
    await flushPromises();
    editor = renderConnected(environmentValue, preparedValue, transientApi);
    expect(editor.props.writeAccess).toBe("unknown");
    expect(editor.props.loadState.kind).toBe("error");
    expect(editor.props.apiKey).toBe(transientDraft);
    const transientSurface = renderEditor(editor);
    expect(
      collectElements(transientSurface, (element) => element.type === Input)[0]?.props.disabled,
    ).toBe(false);
    const retryButton = collectElements(
      transientSurface,
      (element) => element.type === Button && textContent(element) === "Retry status",
    )[0]!;
    (retryButton.props.onClick as () => void)();
    editor = renderConnected(environmentValue, preparedValue, transientApi);
    expect(transientApi.status).toHaveBeenCalledTimes(2);
    retry.resolve({ configured: false, source: null });
    await flushPromises();
    editor = renderConnected(environmentValue, preparedValue, transientApi);
    expect(editor.props.loadState).toEqual({
      kind: "ready",
      status: { configured: false, source: null },
    });
    expect(editor.props.apiKey).toBe(transientDraft);
  });

  it("scrubs a submitted draft when the credential mutation is denied", async () => {
    const environmentId = EnvironmentId.make("host");
    const environmentValue = environment(environmentId, "Host");
    const preparedValue = prepared(environmentId, "Host");
    const statusRequest = deferred<VoiceCredentialStatus>();
    const mutationRequest = deferred<VoiceCredentialStatus>();
    const credentialApi: VoiceCredentialApi = {
      status: vi.fn(() => statusRequest.promise),
      update: vi.fn(() => mutationRequest.promise),
    };

    let editor = renderConnected(environmentValue, preparedValue, credentialApi);
    statusRequest.resolve({ configured: false, source: null });
    await flushPromises();
    editor = renderConnected(environmentValue, preparedValue, credentialApi);
    const deniedDraft = "sk-clear-when-mutation-denies";
    editor.props.onApiKeyChange(deniedDraft);
    editor = renderConnected(environmentValue, preparedValue, credentialApi);
    editor.props.onSave();
    mutationRequest.reject({
      _tag: "EnvironmentOperationForbiddenError",
      reason: "credential_rejected",
    });
    await flushPromises();
    editor = renderConnected(environmentValue, preparedValue, credentialApi);

    expect(editor.props.writeAccess).toBe("denied");
    expect(editor.props.apiKey).toBe("");
    const input = collectElements(renderEditor(editor), (element) => element.type === Input)[0]!;
    expect(input.props.value).toBe("");
    expect(JSON.stringify(input.props)).not.toContain(deniedDraft);
  });

  it("preserves a submitted draft when the credential mutation fails transiently", async () => {
    const environmentId = EnvironmentId.make("host");
    const environmentValue = environment(environmentId, "Host");
    const preparedValue = prepared(environmentId, "Host");
    const statusRequest = deferred<VoiceCredentialStatus>();
    const mutationRequest = deferred<VoiceCredentialStatus>();
    const credentialApi: VoiceCredentialApi = {
      status: vi.fn(() => statusRequest.promise),
      update: vi.fn(() => mutationRequest.promise),
    };

    let editor = renderConnected(environmentValue, preparedValue, credentialApi);
    statusRequest.resolve({ configured: false, source: null });
    await flushPromises();
    editor = renderConnected(environmentValue, preparedValue, credentialApi);
    const transientDraft = "sk-keep-after-transient-mutation";
    editor.props.onApiKeyChange(transientDraft);
    editor = renderConnected(environmentValue, preparedValue, credentialApi);
    editor.props.onSave();
    mutationRequest.reject({ _tag: "RemoteEnvironmentAuthFetchError", message: "redacted" });
    await flushPromises();
    editor = renderConnected(environmentValue, preparedValue, credentialApi);

    expect(editor.props.writeAccess).toBe("granted");
    expect(editor.props.apiKey).toBe(transientDraft);
    expect(editor.props.notice).toBe(
      "T3 could not reach this environment. Check its connection and try again.",
    );
  });

  it.each([
    ["granted", { authenticated: true, scopes: [AuthAccessWriteScope] }],
    ["unknown", { authenticated: true }],
  ] as const)("scrubs a draft when %s session access becomes denied", async (_label, session) => {
    const environmentId = EnvironmentId.make("host");
    const environmentValue = environment(environmentId, "Host");
    const preparedValue = prepared(environmentId, "Host");
    environmentState.session = { data: session, hasError: false, isPending: false };
    const credentialApi = apiWithStatus({ configured: false, source: null });

    let editor = renderConnected(environmentValue, preparedValue, credentialApi);
    await flushPromises();
    editor = renderConnected(environmentValue, preparedValue, credentialApi);
    const sessionDraft = `sk-${_label}-session-draft`;
    editor.props.onApiKeyChange(sessionDraft);
    editor = renderConnected(environmentValue, preparedValue, credentialApi);
    expect(editor.props.apiKey).toBe(sessionDraft);

    environmentState.session = {
      data: { authenticated: true, scopes: ["orchestration:read"] },
      hasError: false,
      isPending: false,
    };
    editor = renderConnected(environmentValue, preparedValue, credentialApi);
    expect(editor.props.writeAccess).toBe("denied");
    expect(editor.props.apiKey).toBe("");

    environmentState.session = { data: session, hasError: false, isPending: false };
    editor = renderConnected(environmentValue, preparedValue, credentialApi);
    expect(editor.props.apiKey).toBe("");
    expect(JSON.stringify(renderEditor(editor).props)).not.toContain(sessionDraft);
  });
});
