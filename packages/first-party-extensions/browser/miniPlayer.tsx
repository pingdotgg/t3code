import { bindApi } from "@t3tools/extension-sdk/capabilities";
import { uiPanelsApi } from "@t3tools/extension-sdk/catalogue";
import { resolveUiKit } from "@t3tools/extension-sdk/ui";
import { Tooltip } from "@t3tools/extension-sdk/authoring";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import type { CaptureSessionRef } from "./capture.js";

export async function readBrowserMiniPlayer(
  host: Pick<ClientHost, "invokeApi" | "discoverApis">,
  session: Pick<ViewSession, "context">,
  signal: AbortSignal,
): Promise<string | null> {
  const apis = await host.discoverApis(session.context, signal);
  if (
    !apis.some(
      (api) => api.id === uiPanelsApi.definition.id && satisfiesSemverRange(api.version, "^1.1.0"),
    )
  )
    throw new Error("Floating previews require a newer T3 Code host.");
  const api = bindApi(uiPanelsApi, host, session.context, "^1.1.0");
  const capabilities = await api.invoke("getCapabilities", {}, signal);
  if (
    !capabilities.operations.getBrowserMiniPlayer ||
    !capabilities.operations.setBrowserMiniPlayer
  )
    throw new Error("This client cannot show a floating preview.");
  return (await api.invoke("getBrowserMiniPlayer", {}, signal)).tabId;
}

export async function setBrowserMiniPlayer(
  host: Pick<ClientHost, "invokeApi">,
  session: Pick<ViewSession, "context">,
  held: CaptureSessionRef,
  open: boolean,
  signal: AbortSignal,
): Promise<string | null> {
  return (
    await bindApi(uiPanelsApi, host, session.context, "^1.1.0").invoke(
      "setBrowserMiniPlayer",
      { tabId: held.tabId, serverEpoch: held.serverEpoch, open },
      signal,
    )
  ).tabId;
}

export function MiniPlayerButton(props: {
  readonly host: ClientHost;
  readonly session: ViewSession;
  readonly held: CaptureSessionRef | null;
  readonly visible: boolean;
  readonly available?: boolean;
  readonly style: CSSProperties;
  readonly report: (message: string) => void;
}) {
  const { host, session, held, visible, style, report, available = true } = props;
  const kit = resolveUiKit(host);
  const Button = kit?.Button ?? "button";
  const tabId = held?.tabId;
  const serverEpoch = held?.serverEpoch;
  const identity = JSON.stringify([
    session.context.resource.environmentId,
    session.context.resource.threadId,
    tabId,
    serverEpoch,
  ]);
  const lifetime = useRef<AbortSignal | null>(null);
  const capability = host.browserMiniPlayer;
  const subscribe = useCallback(
    (listener: () => void) => capability?.subscribe(session.context, listener) ?? (() => {}),
    [capability, session],
  );
  const read = useCallback(() => capability?.read(session.context) ?? null, [capability, session]);
  const active = useSyncExternalStore(subscribe, read, read);
  const readAvailable = useCallback(
    () =>
      tabId != null &&
      serverEpoch != null &&
      (capability?.canFloat(session.context, { tabId, serverEpoch }) ?? false),
    [capability, session, tabId, serverEpoch],
  );
  const pageAvailable = useSyncExternalStore(subscribe, readAvailable, readAvailable);
  const open = active === tabId;
  const [pendingIdentity, setPendingIdentity] = useState<string | null>(null);
  const pending = pendingIdentity === identity;
  useEffect(() => {
    if (!tabId || !serverEpoch) {
      lifetime.current = null;
      return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([session.signal, controller.signal]);
    lifetime.current = signal;
    return () => controller.abort();
  }, [session, tabId, serverEpoch]);
  if (!capability?.supported) return null;
  const label = open ? "Close floating preview" : "Float preview over chat";
  return (
    <Tooltip host={host} label={label}>
      <Button
        {...(kit
          ? ({
              variant: open ? "secondary" : "ghost",
              size: "icon-xs",
              iconTone: open ? "primary" : undefined,
            } as const)
          : { "data-t3-browser-fallback-control": "" })}
        type="button"
        aria-label={label}
        aria-pressed={open}
        disabled={!held || !visible || !available || !pageAvailable || pending}
        style={kit ? undefined : { ...style, ...(open ? { color: "var(--primary)" } : {}) }}
        onClick={() => {
          const signal = lifetime.current;
          if (
            !held ||
            !visible ||
            !available ||
            !pageAvailable ||
            !signal ||
            signal.aborted ||
            pending
          )
            return;
          setPendingIdentity(identity);
          void setBrowserMiniPlayer(host, session, held, !open, signal)
            .then(
              () => {},
              () => {
                if (!signal.aborted) report("Floating preview unavailable. Try again.");
              },
            )
            .finally(() => {
              setPendingIdentity((current) => (current === identity ? null : current));
            });
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4" />
          <rect width="10" height="7" x="12" y="13" rx="2" />
        </svg>
      </Button>
    </Tooltip>
  );
}
