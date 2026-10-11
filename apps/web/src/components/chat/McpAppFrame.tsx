import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import {
  makeMcpAppHost,
  McpAppHostRefusal,
  mcpAppStyleVariables,
  mcpResourceBytes,
  type McpAppCallToolResult,
  type McpAppDisplayMode,
  type McpAppHost,
  type McpAppHostContext,
} from "@t3tools/client-runtime/mcp-apps";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  clampMcpAppHeight,
  MCP_APP_DEFAULT_HEIGHT,
  MCP_APP_MAX_HEIGHT,
  mcpAppAllowAttribute,
  mcpAppFileName,
  type McpAppReference,
} from "@t3tools/shared/mcpApp";
import { Minimize2Icon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { APP_VERSION } from "~/branding";
import { isConfirmDialogActive, requestConfirmDialog } from "~/confirmDialog";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { Button } from "~/components/ui/button";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { useTurnItemDetail } from "~/state/queries";
import { mcpAppEnvironment } from "~/state/mcpApps";
import { useAtomCommand } from "~/state/use-atom-command";
import { observeResize } from "~/lib/observeResize";

const commandFailure = (result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) => {
  const error = squashAtomCommandFailure(result);
  return new McpAppHostRefusal(
    error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.",
  );
};

/** Full screen shows the box in the top layer, which needs the Popover API. */
/** A cached asset URL with less life than this is minted afresh first. */
const MIN_URL_LIFE_MS = 5 * 60_000;
const fullscreenSupported =
  typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;

/** Largest file an app may hand the user through `ui/download-file`. */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/** Saves a file through the browser's own download, which asks where when it is set to. */
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // Long after the browser has read it: some start the download a task or
  // more after the click, and a revoked URL saves nothing.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * An MCP App inline in the thread: the captured document in an opaque-origin
 * frame, speaking the MCP Apps bridge. Its tool calls and resource reads reach
 * its own MCP server through the environment; calls to tools the server does
 * not mark read-only, chat messages, and downloads ask first. Full screen keeps
 * the same frame (and the app's state) and only restyles its box.
 */
export function McpAppFrame(props: {
  readonly environmentId: EnvironmentId;
  /** The thread that produced the app, which its requests run against. */
  readonly threadId: ThreadId;
  /** The thread on screen, whose next turn the app's model context informs. */
  readonly conversationThreadId: ThreadId;
  readonly itemId: TurnItemId;
  /** The item's revision, so its stored call is fetched once per version. */
  readonly revision: string;
  readonly app: McpAppReference;
  readonly onSendMessage: ((text: string) => Promise<void>) | undefined;
  /** The agent waits on the user, in a panel a full-screen app would cover. */
  readonly awaitingUser?: boolean;
  /** Told when the app enters or leaves full screen. */
  readonly onFullscreenChange?: (fullscreen: boolean) => void;
}) {
  const { app } = props;
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(MCP_APP_DEFAULT_HEIGHT);
  const [navigatedAway, setNavigatedAway] = useState(false);
  const [displayMode, setDisplayMode] = useState<McpAppDisplayMode>("inline");
  // The app asked to be closed; the row falls back to its plain tool call.
  const [closed, setClosed] = useState(false);
  // Counts the app documents this row has shown. Reopening a closed app loads
  // a new one, which needs its own host and its own load tracking.
  const [documentGeneration, setDocumentGeneration] = useState(0);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    return observeResize(box, ([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Closing and reopening replaces the box.
  }, [closed]);

  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId: app.attachmentId,
      fileName: mcpAppFileName(app),
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [app],
  );
  const asset = useAssetUrlState(props.environmentId, resource);
  const refreshAsset = useAssetUrlRefresh(props.environmentId, resource);
  // The frame keeps its first URL: a re-minted one would reload the app. A
  // cached URL near expiry is minted afresh first, since a frame cannot
  // report a failed load. At most one mint per document, so a skewed clock
  // cannot mint on every update.
  const [src, setSrc] = useState<string | null>(null);
  const [mintFailed, setMintFailed] = useState(false);
  const minting = useRef(false);
  const cachedUrl = asset._tag === "Success" ? asset.url : null;
  const cachedExpiresAt = asset._tag === "Success" ? asset.expiresAt : 0;
  useEffect(() => {
    if (src !== null || cachedUrl === null || minting.current) return;
    if (cachedExpiresAt - Date.now() > MIN_URL_LIFE_MS) {
      // oxlint-disable-next-line react/set-state-in-effect -- Adopts the cached URL once it is known to last.
      setSrc(cachedUrl);
      return;
    }
    minting.current = true;
    void refreshAsset().then(
      (url) => (url === null ? setMintFailed(true) : setSrc(url)),
      () => setMintFailed(true),
    );
  }, [src, cachedUrl, cachedExpiresAt, refreshAsset]);

  // The wire timeline omits tool input and output; the app needs both.
  const detail = useTurnItemDetail({
    environmentId: props.environmentId,
    threadId: props.threadId,
    itemId: props.itemId,
    revision: props.revision,
  });
  const storedItem = detail.data?.item;
  const toolCall = useMemo(() => {
    if (storedItem?.type !== "dynamic_tool") return undefined;
    const output = storedItem.output as { readonly result?: unknown } | undefined;
    const result = output?.result as McpAppCallToolResult | undefined;
    return { arguments: storedItem.input, result };
  }, [storedItem]);

  const callTool = useAtomCommand(mcpAppEnvironment.callTool, { reportFailure: false });
  const toolInfo = useAtomCommand(mcpAppEnvironment.toolInfo, { reportFailure: false });
  const readResource = useAtomCommand(mcpAppEnvironment.readResource, { reportFailure: false });
  const updateModelContext = useAtomCommand(mcpAppEnvironment.updateModelContext, {
    reportFailure: false,
  });
  // The tool's definition, which the app receives as `toolInfo` at initialize.
  const [toolDefinition, setToolDefinition] = useState<unknown>(undefined);

  // Read by the host on every message, so it always sees current values
  // without being rebuilt (which would drop the app's session).
  const live = {
    theme,
    width,
    props,
    callTool,
    toolInfo,
    readResource,
    updateModelContext,
    displayMode,
    toolDefinition,
  };
  const hostRef = useRef<McpAppHost | null>(null);
  const latest = useRef(live);
  useEffect(() => {
    latest.current = live;
  });

  useEffect(() => {
    const box = boxRef.current;
    if (box === null || !fullscreenSupported) return;
    const shown = box.matches(":popover-open");
    if (displayMode === "fullscreen" && !shown) box.showPopover();
    if (displayMode !== "fullscreen" && shown) box.hidePopover();
    // Reported only on a change, so an inline row never touches another
    // row's pin.
    if (displayMode === "fullscreen") {
      latest.current.props.onFullscreenChange?.(true);
      return () => latest.current.props.onFullscreenChange?.(false);
    }
  }, [displayMode]);
  // The approval or question the agent waits on renders in the page, so a
  // full-screen app steps aside for it.
  const [stepAsideFor, setStepAsideFor] = useState(props.awaitingUser);
  if (stepAsideFor !== props.awaitingUser) {
    setStepAsideFor(props.awaitingUser);
    if (props.awaitingUser === true) setDisplayMode("inline");
  }
  // Full screen sits above everything else in the page. Anything that takes
  // focus outside it (an approval, the command palette, a dialog) returns the
  // app inline so it can be seen; so does Escape pressed outside the app.
  // Keys pressed inside the app stay with the app.
  useEffect(() => {
    if (displayMode !== "fullscreen") return;
    const leave = () => setDisplayMode("inline");
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !boxRef.current?.contains(event.target)) leave();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") leave();
    };
    const onResize = () => hostRef.current?.updateHostContext();
    document.addEventListener("focusin", onFocus);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [displayMode]);

  // The definition is read once per app, before the host is built, so the
  // initialize response can carry it; a failure only leaves it out.
  useEffect(() => {
    let cancelled = false;
    void latest.current
      .toolInfo({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, itemId: props.itemId, name: app.tool },
      })
      .then((info) => {
        if (!cancelled && info._tag === "Success" && info.value.tool !== undefined) {
          setToolDefinition(info.value.tool);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.environmentId, props.threadId, props.itemId, app.tool]);
  // The bridge belongs to the captured document. A frame that navigates keeps
  // its window, so a second load stops the app rather than letting a page T3
  // never served pose as it. This is not a confidentiality boundary: a frame
  // can always navigate itself, so the app could carry anything it read out
  // in a URL either way.
  // Counted per document: a reopened app is a new document, not a navigation.
  const loads = useRef({ generation: 0, count: 0 });
  const onFrameLoad = () => {
    if (loads.current.generation !== documentGeneration) {
      loads.current = { generation: documentGeneration, count: 0 };
    }
    loads.current.count += 1;
    if (loads.current.count > 1) {
      hostRef.current?.dispose();
      setNavigatedAway(true);
    }
  };

  useEffect(() => {
    if (src === null) return;
    const hostContext = (): McpAppHostContext => {
      const current = latest.current;
      return {
        theme: current.theme.appearance,
        styles: { variables: mcpAppStyleVariables(current.theme.variables) },
        displayMode: current.displayMode,
        availableDisplayModes: fullscreenSupported ? ["inline", "fullscreen"] : ["inline"],
        containerDimensions:
          current.displayMode === "fullscreen"
            ? {
                width: frameRef.current?.clientWidth || window.innerWidth,
                height: frameRef.current?.clientHeight || window.innerHeight,
              }
            : { width: current.width, maxHeight: MCP_APP_MAX_HEIGHT },
        platform: isElectron ? "desktop" : "web",
        locale: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        userAgent: `t3-code/${APP_VERSION}`,
        deviceCapabilities: {
          touch: window.matchMedia("(pointer: coarse)").matches,
          hover: window.matchMedia("(hover: hover)").matches,
        },
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        ...(current.toolDefinition === undefined
          ? {}
          : { toolInfo: { tool: current.toolDefinition } }),
      };
    };
    // Approvals render in the page, beneath the top layer a full-screen app
    // occupies, so the app returns inline before T3 asks.
    const ask = async (message: string) => {
      flushSync(() => setDisplayMode("inline"));
      const approved = await requestConfirmDialog(message);
      // No dialog host is mounted, so nobody was asked; say so rather than
      // reporting that the user declined.
      if (approved === undefined) {
        throw new McpAppHostRefusal("T3 could not ask for approval here.");
      }
      return approved;
    };
    const target = () => frameRef.current?.contentWindow ?? null;
    const scope = () => {
      const { environmentId, threadId, itemId } = latest.current.props;
      return { environmentId, input: { threadId, itemId } };
    };
    const host = makeMcpAppHost({
      app,
      hostVersion: APP_VERSION,
      // The document's origin is opaque, so "*" is the only target that reaches it;
      // the window reference itself is what scopes delivery to this frame.
      post: (message) => target()?.postMessage(message, "*"),
      hostContext,
      callTool: async ({ name, arguments: args }) => {
        const { environmentId, input } = scope();
        const info = await latest.current.toolInfo({ environmentId, input: { ...input, name } });
        if (info._tag !== "Success") throw commandFailure(info);
        if (!info.value.callable) throw new McpAppHostRefusal("This app cannot call that tool.");
        if (!info.value.readOnly) {
          const approved = await ask(
            `Allow ${app.server} to run ${info.value.title ?? name}?\n${JSON.stringify(args, null, 2)}`,
          );
          if (approved !== true) throw new McpAppHostRefusal("Declined by the user.");
        }
        const result = await latest.current.callTool({
          environmentId,
          input: { ...input, name, arguments: args },
        });
        if (result._tag !== "Success") throw commandFailure(result);
        return result.value;
      },
      readResource: async ({ uri }) => {
        const { environmentId, input } = scope();
        const result = await latest.current.readResource({
          environmentId,
          input: { ...input, uri },
        });
        if (result._tag !== "Success") throw commandFailure(result);
        return result.value;
      },
      openLink: async (url) => {
        // Only right after the reader used this frame, as with HTML renders.
        if (document.activeElement !== frameRef.current || !navigator.userActivation?.isActive) {
          throw new McpAppHostRefusal("Links open only from a click in the app.");
        }
        window.open(url, "_blank", "noopener,noreferrer");
      },
      sendMessage: async (text) => {
        const send = latest.current.props.onSendMessage;
        if (send === undefined) throw new McpAppHostRefusal("Messages are not available here.");
        const approved = await ask(`Send this message from ${app.server}?\n${text}`);
        if (approved !== true) throw new McpAppHostRefusal("Declined by the user.");
        await send(text);
      },
      updateModelContext: async (context) => {
        const { environmentId, input } = scope();
        const result = await latest.current.updateModelContext({
          environmentId,
          input: {
            ...input,
            ...context,
            conversationThreadId: latest.current.props.conversationThreadId,
          },
        });
        if (result._tag !== "Success") throw commandFailure(result);
      },
      requestDisplayMode: async (mode) => {
        // Full screen would cover the approval or question the agent waits
        // on, or a confirmation any app is waiting on. Another app already
        // full screen keeps the page; two would stack.
        const otherFullscreen = document.querySelector("[data-mcp-app-fullscreen]");
        if (
          mode === "fullscreen" &&
          (latest.current.props.awaitingUser === true ||
            isConfirmDialogActive() ||
            (otherFullscreen !== null && otherFullscreen !== boxRef.current))
        ) {
          return latest.current.displayMode;
        }
        setDisplayMode(mode);
        return mode;
      },
      downloadFile: async (files) => {
        const names = files.map((file) => file.name).join(", ");
        const approved = await ask(`Save ${names} from ${app.server}?`);
        if (approved !== true) throw new McpAppHostRefusal("Declined by the user.");
        for (const file of files) {
          // A linked file is read from the app's own server, like its other reads.
          let bytes: Uint8Array | undefined;
          let mimeType = file.mimeType ?? "application/octet-stream";
          if (file._tag === "embedded") {
            bytes = file.bytes;
          } else {
            const { environmentId, input } = scope();
            const read = await latest.current.readResource({
              environmentId,
              input: { ...input, uri: file.uri },
            });
            if (read._tag !== "Success") throw commandFailure(read);
            const content = read.value.contents[0];
            bytes = mcpResourceBytes(content);
            const declared = (content as { readonly mimeType?: unknown } | undefined)?.mimeType;
            if (typeof declared === "string") mimeType = declared;
          }
          if (bytes === undefined) throw new McpAppHostRefusal(`${file.name} has no contents.`);
          if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
            throw new McpAppHostRefusal(`${file.name} is too large to save.`);
          }
          // A copy backed by a plain ArrayBuffer, which Blob requires.
          saveBlob(new Blob([bytes.slice()], { type: mimeType }), file.name);
        }
      },
      onRequestTeardown: () => {
        if (latest.current.displayMode === "fullscreen") {
          setDisplayMode("inline");
          return;
        }
        // The app asked to go, so it gets its teardown before the frame does.
        void host.teardown().then(() => setClosed(true));
      },
      onSizeChanged: (size) => {
        // Full screen is a fixed box; what the app reports there would leave
        // the inline row its full-screen height on the way back.
        if (latest.current.displayMode === "fullscreen") return;
        if (size.height !== undefined) setHeight(clampMcpAppHeight(size.height));
      },
    });
    hostRef.current = host;
    const receive = (event: MessageEvent) => {
      // Only messages from this frame's own window reach its host.
      if (event.source !== null && event.source === target()) host.receive(event.data);
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      // An unmount cannot wait: the request goes out before the frame does,
      // which is all a list that recycles rows can offer the app.
      void host.teardown();
      hostRef.current = null;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A reopened document needs a new host.
  }, [src, app, documentGeneration]);

  // The host reads the context through `latest`; these only say when to resend.
  useEffect(() => {
    hostRef.current?.updateHostContext();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Context changes trigger a resend.
  }, [theme, width, displayMode, toolDefinition]);

  // A new document gets a new host, which needs the call again.
  useEffect(() => {
    if (toolCall !== undefined) hostRef.current?.setToolCall(toolCall);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each new document needs the call.
  }, [toolCall, src, documentGeneration]);

  // An app that asked to close keeps the box an inline row had, so the
  // timeline does not jump, and says how to bring it back.
  if (closed) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-muted-foreground text-xs">
        <span>The {app.server} app was closed</span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            // The first URL's token may have expired: the new document
            // takes a fresh one, minted again if it is near expiry.
            minting.current = false;
            setSrc(null);
            setDocumentGeneration((value) => value + 1);
            setClosed(false);
          }}
        >
          Show app
        </Button>
      </div>
    );
  }

  const fullscreen = displayMode === "fullscreen";
  return (
    // The row keeps its inline height while the app is full screen, so the
    // timeline does not jump; the box itself is what goes full screen.
    <div style={{ height }}>
      <div
        ref={boxRef}
        // Full screen is the same box shown in the browser's top layer: moving
        // the frame to another parent would reload the app, and the timeline's
        // rows contain fixed positioning, which the top layer escapes.
        {...(fullscreenSupported ? { popover: "manual" as const } : {})}
        data-mcp-app-fullscreen={fullscreen ? "" : undefined}
        className={cn(
          "relative size-full overflow-hidden",
          app.prefersBorder === true && !fullscreen && "rounded-lg border border-border",
          fullscreen
            ? "fixed inset-0 m-0 flex h-dvh max-h-none w-dvw max-w-none flex-col border-0 bg-background p-0"
            : // A closed popover is hidden; inline, the box is a plain block.
              "block! static! m-0 border-0 bg-transparent p-0 text-inherit",
        )}
      >
        {fullscreen ? (
          <div className="flex h-10 shrink-0 items-center justify-between border-border border-b px-3 text-sm">
            <span className="truncate">{app.server}</span>
            <Button
              aria-label="Exit full screen"
              size="icon-sm"
              variant="ghost"
              onClick={() => setDisplayMode("inline")}
            >
              <Minimize2Icon className="size-4" />
            </Button>
          </div>
        ) : null}
        {navigatedAway ? (
          <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
            The {app.server} app left its page and was stopped
          </p>
        ) : src !== null ? (
          <iframe
            ref={frameRef}
            src={src}
            title={`${app.server} app`}
            // Never allow-same-origin: the opaque origin keeps the app out of the session.
            sandbox="allow-scripts allow-forms"
            allow={mcpAppAllowAttribute(app.permissions)}
            onLoad={onFrameLoad}
            className={cn("block w-full border-0", fullscreen ? "min-h-0 flex-1" : "h-full")}
            style={{ colorScheme: theme.appearance }}
          />
        ) : asset._tag === "Failure" || mintFailed ? (
          <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
            Unable to load the {app.server} app
          </p>
        ) : null}
      </div>
    </div>
  );
}
