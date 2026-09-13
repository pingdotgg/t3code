import {
  createMessageArtifactHost,
  createSandboxedMessageArtifactDocument,
  loadMessageArtifactSource,
  messageArtifactAssetResource,
  messageArtifactFileName,
  MESSAGE_ARTIFACT_DEFAULT_FRAME_HEIGHT,
  MESSAGE_ARTIFACT_MAX_FRAME_HEIGHT,
  MESSAGE_ARTIFACT_NAVIGATED_MESSAGE,
  MESSAGE_ARTIFACT_UNAVAILABLE_MESSAGE,
  readMessageArtifactMemory,
  rememberMessageArtifact,
  setMessageArtifactHeightStore,
  type MessageArtifactHost,
  type MessageArtifactHostContext,
  type MessageArtifactSource,
  type MessageArtifactStyleVariable,
} from "@t3tools/client-runtime/message-artifacts";
import type { EnvironmentId } from "@t3tools/contracts";
import { CodeIcon, EyeIcon, EyeOffIcon, RefreshCwIcon } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { clampInterfaceFontSize } from "~/appearanceFonts";
import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { useOpenLink } from "~/browser/useOpenLink";
import { isElectron } from "~/env";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { PierreEntryIcon } from "./PierreEntryIcon";

// One window listener routes frame messages to the frame that sent them.
const frameMessageHandlers = new Map<MessageEventSource, (data: unknown) => void>();

function receiveFrameMessage(event: MessageEvent<unknown>) {
  if (event.source === null) return;
  frameMessageHandlers.get(event.source)?.(event.data);
}

function registerFrameMessageHandler(source: MessageEventSource, handler: (data: unknown) => void) {
  if (frameMessageHandlers.size === 0) window.addEventListener("message", receiveFrameMessage);
  frameMessageHandlers.set(source, handler);
  return () => {
    frameMessageHandlers.delete(source);
    if (frameMessageHandlers.size === 0) window.removeEventListener("message", receiveFrameMessage);
  };
}

const HEIGHT_STORAGE_KEY = "t3code:message-artifact-heights:v1";

// Heights outlive reloads so a reopened thread keeps its layout. The shared store ignores
// storage that throws or is missing.
setMessageArtifactHeightStore({
  read: () => localStorage.getItem(HEIGHT_STORAGE_KEY),
  write: (value) => localStorage.setItem(HEIGHT_STORAGE_KEY, value),
});

/**
 * The app values behind each MCP Apps theme variable. The frame has neither the app tokens nor its
 * root font size, so `var()` and `rem` are resolved here.
 */
const STYLE_VARIABLE_VALUES: Record<MessageArtifactStyleVariable, string> = {
  "--color-background-primary": "var(--code-background)",
  "--color-background-secondary": "var(--secondary)",
  "--color-background-tertiary": "var(--accent)",
  "--color-background-inverse": "var(--foreground)",
  "--color-background-info": "color-mix(in srgb, var(--info) 12%, transparent)",
  "--color-background-success": "color-mix(in srgb, var(--success) 12%, transparent)",
  "--color-background-warning": "var(--warning-surface)",
  "--color-background-danger": "var(--error-surface)",
  "--color-text-primary": "var(--foreground)",
  "--color-text-secondary": "var(--muted-foreground)",
  "--color-text-tertiary": "var(--secondary-label)",
  "--color-text-inverse": "var(--background)",
  "--color-text-info": "var(--info-foreground)",
  "--color-text-success": "var(--success-foreground)",
  "--color-text-warning": "var(--warning-foreground)",
  "--color-text-danger": "var(--destructive)",
  "--color-border-primary": "var(--border)",
  "--color-border-secondary": "var(--input)",
  "--color-border-danger": "color-mix(in srgb, var(--destructive) 32%, transparent)",
  "--color-ring-primary": "var(--ring)",
  "--font-sans": "var(--font-sans)",
  "--font-mono": "var(--font-mono)",
  // Chat text is `text-sm`, small print `text-xs`.
  "--font-text-sm-size": "0.75rem",
  "--font-text-md-size": "0.875rem",
  "--border-radius-sm": "calc(var(--radius) - 4px)",
  "--border-radius-md": "var(--radius)",
  "--border-radius-lg": "calc(var(--radius) + 4px)",
  "--border-radius-full": "9999px",
};

// Theme changes re-render through `useTheme`, and the values are read from the applied styles.
// The interface size is read from settings, since the root font size applies after this render.
function useArtifactHostContext(): MessageArtifactHostContext {
  const { theme, resolvedTheme, themeHalves, appearanceMode } = useTheme();
  const fontSizeInterface = useClientSettings((settings) => settings.fontSizeInterface);
  return useMemo(() => {
    const styles = getComputedStyle(document.documentElement);
    const rootFontSize = clampInterfaceFontSize(fontSizeInterface);
    const resolve = (value: string) =>
      value
        .replace(/var\((--[\w-]+)\)/gu, (_match, token: string) =>
          styles.getPropertyValue(token).trim(),
        )
        .replace(/(\d*\.?\d+)rem\b/gu, (_match, amount: string) => {
          return `${Number(amount) * rootFontSize}px`;
        });
    return {
      theme: resolvedTheme,
      platform: isElectron ? "desktop" : "web",
      containerDimensions: { maxHeight: MESSAGE_ARTIFACT_MAX_FRAME_HEIGHT },
      styles: {
        variables: Object.fromEntries(
          Object.entries(STYLE_VARIABLE_VALUES).map(([name, value]) => [name, resolve(value)]),
        ) as Record<MessageArtifactStyleVariable, string>,
      },
    };
  }, [theme, resolvedTheme, themeHalves, appearanceMode, fontSizeInterface]);
}

function ArtifactHeaderAction(props: {
  readonly label: string;
  readonly state: { readonly "aria-pressed": boolean } | { readonly "aria-expanded": boolean };
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="chat-markdown-chrome-action"
            aria-label={props.label}
            {...props.state}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export interface MessageArtifactCardProps {
  readonly environmentId: EnvironmentId;
  /** The text attachment holding the copy the server saved, or null until there is one. */
  readonly attachmentId: string | null;
  readonly path: string;
}

/** Shows a message's `t3-artifact` in place, running its saved copy in an opaque-origin iframe. */
export const MessageArtifactCard = memo(function MessageArtifactCard(
  props: MessageArtifactCardProps,
) {
  const { attachmentId } = props;
  const fileName = messageArtifactFileName(props.path);
  const { resolvedTheme } = useTheme();
  const [attempt, setAttempt] = useState(0);
  const [hidden, setHidden] = useState(
    () => attachmentId !== null && readMessageArtifactMemory(attachmentId)?.hidden === true,
  );
  const [showSource, setShowSource] = useState(false);

  return (
    <section
      data-message-artifact="true"
      aria-label={fileName}
      className="chat-markdown-codeblock my-[0.65rem] min-w-0 overflow-hidden rounded-[var(--radius)] border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
    >
      <div className="chat-markdown-codeblock-header flex items-center justify-between gap-2 py-1 pr-1.5 pl-3 select-none">
        <span className="inline-flex min-h-6 min-w-0 items-center gap-[0.4rem] [font-family:var(--font-mono,ui-monospace,SFMono-Regular,monospace)] [font-size:0.6875rem]">
          <PierreEntryIcon
            pathValue={fileName}
            kind="file"
            theme={resolvedTheme}
            className="size-3.5"
          />
          <span className="truncate">{fileName}</span>
        </span>
        {attachmentId === null ? null : (
          <span className="flex items-center gap-0.5" role="toolbar" aria-label="Artifact actions">
            {hidden ? null : (
              <ArtifactHeaderAction
                label="View source"
                state={{ "aria-pressed": showSource }}
                onClick={() => setShowSource((value) => !value)}
              >
                <CodeIcon className="size-3" />
              </ArtifactHeaderAction>
            )}
            <ArtifactHeaderAction
              label={hidden ? "Expand artifact" : "Collapse artifact"}
              state={{ "aria-expanded": !hidden }}
              onClick={() => {
                setHidden(!hidden);
                rememberMessageArtifact(attachmentId, { hidden: !hidden });
              }}
            >
              {hidden ? <EyeIcon className="size-3" /> : <EyeOffIcon className="size-3" />}
            </ArtifactHeaderAction>
          </span>
        )}
      </div>
      {attachmentId === null ? (
        <p className="truncate px-3 pb-2.5 font-mono text-xs text-muted-foreground">{props.path}</p>
      ) : hidden ? null : (
        <MessageArtifactBody
          key={attempt}
          attachmentId={attachmentId}
          environmentId={props.environmentId}
          fileName={fileName}
          showSource={showSource}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      )}
    </section>
  );
});

function MessageArtifactBody(props: {
  readonly attachmentId: string;
  readonly environmentId: EnvironmentId;
  readonly fileName: string;
  readonly showSource: boolean;
  readonly onRetry: () => void;
}) {
  const { attachmentId, fileName } = props;
  const resource = useMemo(
    () => messageArtifactAssetResource(attachmentId, fileName),
    [attachmentId, fileName],
  );
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  const url = assetUrl._tag === "Success" ? assetUrl.url : null;
  const [source, setSource] = useState<MessageArtifactSource | null>(() => {
    const remembered = readMessageArtifactMemory(attachmentId)?.source;
    return remembered === undefined ? null : { _tag: "Ready", source: remembered };
  });
  const [navigatedAway, setNavigatedAway] = useState(false);
  const loadedRef = useRef(source !== null);
  const urlRef = useRef(url);

  useEffect(() => {
    urlRef.current = url;
  });

  // Fetch once, then reuse the remembered copy on remounts. The URL drops out on every reconnect
  // and renews in the background; reloading the page then would discard the user's work.
  const hasUrl = url !== null;
  useEffect(() => {
    const documentUrl = urlRef.current;
    if (!hasUrl || documentUrl === null || loadedRef.current) return;
    const abortController = new AbortController();
    void loadMessageArtifactSource(documentUrl, abortController.signal).then((loaded) => {
      if (abortController.signal.aborted) return;
      loadedRef.current = true;
      if (loaded._tag === "Ready") rememberMessageArtifact(attachmentId, { source: loaded.source });
      setSource(loaded);
    });
    return () => abortController.abort();
  }, [attachmentId, hasUrl]);

  const failure = navigatedAway
    ? MESSAGE_ARTIFACT_NAVIGATED_MESSAGE
    : source?._tag === "Failure"
      ? source.message
      : source === null && assetUrl._tag === "Failure"
        ? MESSAGE_ARTIFACT_UNAVAILABLE_MESSAGE
        : null;

  if (failure !== null) {
    return (
      <div className="flex min-h-24 flex-col items-center justify-center gap-3 border-t border-border/60 p-4 text-center">
        <p className="max-w-lg text-sm text-muted-foreground">{failure}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            // Retrying renews the signed URL, then remounts with a fresh fetch.
            void refreshAssetUrl()
              .catch(() => undefined)
              .finally(props.onRetry);
          }}
        >
          <RefreshCwIcon aria-hidden className="size-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (source?._tag !== "Ready") {
    return (
      <div
        className="flex items-center justify-center text-muted-foreground"
        style={{
          height:
            readMessageArtifactMemory(attachmentId)?.height ??
            MESSAGE_ARTIFACT_DEFAULT_FRAME_HEIGHT,
        }}
      >
        <Spinner className="size-4" aria-label={`Loading ${fileName}`} />
      </div>
    );
  }

  if (props.showSource) {
    return (
      <div
        role="region"
        aria-label={`${fileName} source`}
        className="max-h-[720px] overflow-auto px-3 pt-1 pb-3 font-mono text-[length:var(--font-size-code,0.75rem)] leading-relaxed break-words whitespace-pre-wrap text-foreground/85 select-text"
      >
        {source.source}
      </div>
    );
  }

  return (
    <MessageArtifactFrame
      artifactKey={attachmentId}
      fileName={fileName}
      source={source.source}
      onNavigatedAway={setNavigatedAway}
    />
  );
}

/** Mounts with a document built from the latest remembered state, so toggling source keeps work. */
function MessageArtifactFrame(props: {
  readonly artifactKey: string;
  readonly fileName: string;
  readonly source: string;
  readonly onNavigatedAway: (navigatedAway: true) => void;
}) {
  const { artifactKey, onNavigatedAway } = props;
  const context = useArtifactHostContext();
  const openLink = useOpenLink(null);
  const latestRef = useRef({ context, openLink });
  const frameRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<MessageArtifactHost | null>(null);
  const loadsRef = useRef(0);
  const [frameHeight, setFrameHeight] = useState(
    () => readMessageArtifactMemory(artifactKey)?.height ?? MESSAGE_ARTIFACT_DEFAULT_FRAME_HEIGHT,
  );
  const [frameDocument] = useState(() =>
    createSandboxedMessageArtifactDocument(props.source, {
      context,
      state: readMessageArtifactMemory(artifactKey)?.state,
    }),
  );

  useEffect(() => {
    latestRef.current = { context, openLink };
  });

  // Created before the document loads, so the page's first `ui/initialize` is never missed.
  useLayoutEffect(() => {
    const frameWindow = frameRef.current?.contentWindow;
    if (frameWindow === null || frameWindow === undefined) return;
    const host = createMessageArtifactHost({
      key: artifactKey,
      context: latestRef.current.context,
      send: (message) => frameWindow.postMessage(message, "*"),
      onHeight: (height) => {
        setFrameHeight(height);
        rememberMessageArtifact(artifactKey, { height });
      },
      // A click inside the frame activates this window too, so a page cannot open links on its own.
      openLink: (url) => {
        if (!navigator.userActivation?.isActive) return false;
        void latestRef.current.openLink(url).catch(() => undefined);
        return true;
      },
      onUnload: () => onNavigatedAway(true),
    });
    hostRef.current = host;
    const unregister = registerFrameMessageHandler(frameWindow, host.receive);
    return () => {
      hostRef.current = null;
      unregister();
    };
  }, [artifactKey, onNavigatedAway]);

  useEffect(() => {
    hostRef.current?.updateContext(context);
  }, [context]);

  return (
    <div style={{ height: frameHeight }}>
      <iframe
        ref={frameRef}
        srcDoc={frameDocument}
        title={props.fileName}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="size-full border-0 bg-transparent"
        onLoad={() => {
          // A frame loads its document once; a later load means the page navigated itself.
          loadsRef.current += 1;
          if (loadsRef.current > 1) onNavigatedAway(true);
        }}
      />
    </div>
  );
}
