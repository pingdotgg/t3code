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
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

const MIN_URL_LIFE_MS = 5 * 60_000;
const fullscreenSupported =
  typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

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

// The host gets the tool call pushed by an effect keyed on it, so it stays
// stable across the command hooks that follow.
function useToolCall(
  storedItem: NonNullable<ReturnType<typeof useTurnItemDetail>["data"]>["item"] | undefined,
) {
  "use memo";
  if (storedItem?.type !== "dynamic_tool") return undefined;
  const output = storedItem.output as { readonly result?: unknown } | undefined;
  const result = output?.result as McpAppCallToolResult | undefined;
  return { arguments: storedItem.input, result };
}

export function McpAppFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly conversationThreadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly revision: string;
  readonly app: McpAppReference;
  readonly onSendMessage: ((text: string) => Promise<void>) | undefined;
  readonly awaitingUser?: boolean;
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
  const [closed, setClosed] = useState(false);
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

  const resource = {
    _tag: "attachment" as const,
    attachmentId: app.attachmentId,
    fileName: mcpAppFileName(app),
    mimeType: "text/html",
    disposition: "inline" as const,
    renderIntent: "mcp-app" as const,
  };
  const asset = useAssetUrlState(props.environmentId, resource);
  const refreshAsset = useAssetUrlRefresh(props.environmentId, resource);
  // The frame keeps its first URL: a re-minted one would reload the app. A
  // cached URL near expiry is minted afresh first, since a frame cannot report
  // a failed load.
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

  const detail = useTurnItemDetail({
    environmentId: props.environmentId,
    threadId: props.threadId,
    itemId: props.itemId,
    revision: props.revision,
  });
  const storedItem = detail.data?.item;
  const toolCall = useToolCall(storedItem);

  const callTool = useAtomCommand(mcpAppEnvironment.callTool, { reportFailure: false });
  const toolInfo = useAtomCommand(mcpAppEnvironment.toolInfo, { reportFailure: false });
  const readResource = useAtomCommand(mcpAppEnvironment.readResource, { reportFailure: false });
  const updateModelContext = useAtomCommand(mcpAppEnvironment.updateModelContext, {
    reportFailure: false,
  });
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
    if (displayMode === "fullscreen") {
      latest.current.props.onFullscreenChange?.(true);
      return () => latest.current.props.onFullscreenChange?.(false);
    }
  }, [displayMode]);
  const [stepAsideFor, setStepAsideFor] = useState(props.awaitingUser);
  if (stepAsideFor !== props.awaitingUser) {
    setStepAsideFor(props.awaitingUser);
    if (props.awaitingUser === true) setDisplayMode("inline");
  }
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
  // never served pose as it.
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
          saveBlob(new Blob([bytes.slice()], { type: mimeType }), file.name);
        }
      },
      onRequestTeardown: () => {
        if (latest.current.displayMode === "fullscreen") {
          setDisplayMode("inline");
          return;
        }
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
      if (event.source !== null && event.source === target()) host.receive(event.data);
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      void host.teardown();
      hostRef.current = null;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A reopened document needs a new host.
  }, [src, app, documentGeneration]);

  useEffect(() => {
    hostRef.current?.updateHostContext();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Context changes trigger a resend.
  }, [theme, width, displayMode, toolDefinition]);

  useEffect(() => {
    if (toolCall !== undefined) hostRef.current?.setToolCall(toolCall);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each new document needs the call.
  }, [toolCall, src, documentGeneration]);

  if (closed) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-muted-foreground text-xs">
        <span>The {app.server} app was closed</span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
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
            : "block! static! m-0 border-0 bg-transparent p-0 text-inherit",
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
