import {
  uiEditorApi,
  type UiEditorCapabilities,
  type UiEditorOpenInput,
} from "@t3tools/extension-sdk/catalogue";
import { bindApi } from "@t3tools/extension-sdk/capabilities";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { useEffect, useRef, useState } from "react";

type EditorState =
  | { readonly kind: "idle" }
  | { readonly kind: "opening" | "opened"; readonly path: string }
  | { readonly kind: "failed"; readonly path: string; readonly message: string };

type Probe = {
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  readonly promise: Promise<UiEditorCapabilities | null>;
  value?: UiEditorCapabilities | null;
};
const probes = new WeakMap<ClientHost, Map<string, Probe>>();

function cachedProbe(host: ClientHost, session: ViewSession) {
  const key = JSON.stringify(session.context);
  let cache = probes.get(host);
  if (!cache) {
    cache = new Map();
    probes.set(host, cache);
  }
  const cached = cache.get(key);
  if (
    cached &&
    (cached.value !== undefined || !cached.signal.aborted) &&
    cached.expiresAt > Date.now()
  )
    return cached;
  const promise = bindApi(uiEditorApi, host, session.context, "^1.1.0")
    .invoke("getCapabilities", {}, session.signal)
    .then(
      (value) => value,
      () => null,
    );
  const probe: Probe = { signal: session.signal, expiresAt: Date.now() + 30_000, promise };
  cache.set(key, probe);
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  void promise.then((value) => {
    probe.value = value;
    if (value === null && cache.get(key) === probe) cache.delete(key);
  });
  return probe;
}

export function useExternalEditor(host: ClientHost, session: ViewSession) {
  const [support, setSupport] = useState<{
    host: ClientHost;
    session: ViewSession;
    capabilities: UiEditorCapabilities | null;
  } | null>(() => {
    const cached = probes.get(host)?.get(JSON.stringify(session.context));
    return {
      host,
      session,
      capabilities:
        cached &&
        (cached.value !== undefined || !cached.signal.aborted) &&
        cached.expiresAt > Date.now()
          ? (cached.value ?? null)
          : null,
    };
  });
  const [outcome, setOutcome] = useState<{
    host: ClientHost;
    session: ViewSession;
    state: EditorState;
  } | null>(null);
  const lifetime = useRef<AbortSignal | null>(null);
  const hintShown = useRef(false);
  const activeOpen = useRef(false);
  const state =
    outcome?.host === host && outcome.session === session
      ? outcome.state
      : { kind: "idle" as const };
  const capabilities =
    support?.host === host && support.session === session ? support.capabilities : null;
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    lifetime.current = signal;
    hintShown.current = false;
    activeOpen.current = false;
    const probe = cachedProbe(host, session);
    void probe.promise.then((answer) => {
      if (!signal.aborted) setSupport({ host, session, capabilities: probe.value ?? answer });
    });
    return () => controller.abort();
  }, [host, session]);
  const visible = capabilities?.editor?.visible === true;
  const blockReason =
    !visible || capabilities?.operations.openPath !== true
      ? "No connected client can open an editor."
      : null;
  const hideVersionError = (message: string) => {
    if (!/t3\.client\/editor|workspace openPath needs/.test(message)) return false;
    probes.get(host)?.delete(JSON.stringify(session.context));
    setSupport({ host, session, capabilities: null });
    setOutcome({ host, session, state: { kind: "idle" } });
    return true;
  };
  const openInEditor = (path: string, editor?: string) => {
    const signal = lifetime.current;
    if (blockReason !== null || !signal || signal.aborted || activeOpen.current) return;
    activeOpen.current = true;
    setOutcome({ host, session, state: { kind: "opening", path } });
    const hintWasShown = hintShown.current;
    const input: UiEditorOpenInput = {
      path,
      workspace: true,
      ...(editor ? { editor } : {}),
      ...(hintWasShown ? { hintShown: true } : {}),
    };
    const opened =
      host.openEditorPath && capabilities?.adapter === "host.ui.editor"
        ? host.openEditorPath(input, session.context, signal)
        : bindApi(uiEditorApi, host, session.context, "^1.1.0").invoke("openPath", input, signal);
    void opened.then(
      (receipt) => {
        if (signal.aborted) return;
        activeOpen.current = false;
        if (receipt.status === "refused" && hideVersionError(receipt.message)) return;
        if (receipt.status === "opened" && capabilities?.editor) {
          const answer = {
            ...capabilities,
            editor: {
              ...capabilities.editor,
              preferredEditor: receipt.editor,
              remoteHint: hintWasShown ? null : capabilities.editor.remoteHint,
            },
          };
          const probe = probes.get(host)?.get(JSON.stringify(session.context));
          if (probe) probe.value = answer;
          setSupport({ host, session, capabilities: answer });
        }
        setOutcome({
          host,
          session,
          state:
            receipt.status === "opened"
              ? { kind: "opened", path }
              : { kind: "failed", path, message: receipt.message },
        });
      },
      (error: unknown) => {
        if (signal.aborted) return;
        activeOpen.current = false;
        const message = error instanceof Error ? error.message : "Unable to open file in editor.";
        if (!hideVersionError(message))
          setOutcome({ host, session, state: { kind: "failed", path, message } });
      },
    );
  };
  return {
    visible,
    blockReason,
    state,
    openInEditor,
    editors: capabilities?.editor?.editors ?? [],
    preferredEditor: capabilities?.editor?.preferredEditor ?? null,
    remoteHint: capabilities?.editor?.remoteHint ?? null,
    markHintShown: () => {
      if (capabilities?.editor?.remoteHint) hintShown.current = true;
    },
  };
}
