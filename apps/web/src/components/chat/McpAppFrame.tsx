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
import { useEffect, useRef, useState, type FocusEvent, type ToggleEvent } from "react";
import { flushSync } from "react-dom";

import { useLongLivedAssetUrl } from "~/assets/longLivedAssetUrls";
import { APP_VERSION } from "~/branding";
import { isConfirmDialogActive, requestConfirmDialog } from "~/confirmDialog";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { useStableCallback } from "~/hooks/useStableCallback";
import { Button } from "~/components/ui/button";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
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

const fullscreenSupported =
  typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
// Exclude activation left by input elsewhere in T3.
const PAGE_ACTIVATION_MS = 5_000;

// Frame input does not bubble here. An app can refocus itself, so focus
// alone cannot exclude activation from input elsewhere in T3.
let lastPageInputAt = Number.NEGATIVE_INFINITY;
if (typeof window !== "undefined") {
  const note = () => {
    lastPageInputAt = performance.now();
  };
  if (navigator.userActivation?.isActive) note();
  for (const type of ["pointerdown", "pointerup", "touchend", "keydown"] as const) {
    window.addEventListener(type, note, true);
  }
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // Browsers may start downloading after the click's task; defer revocation.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
  // Closing and reopening replaces the box, which re-attaches this.
  const attachBox = (box: HTMLDivElement) => {
    boxRef.current = box;
    setWidth(box.clientWidth);
    const stopResize = observeResize(box, ([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
      // Full screen reports the viewport, which can change height alone.
      if (fullscreenSupported && box.matches(":popover-open")) {
        hostRef.current?.updateHostContext();
      }
    });
    return () => {
      stopResize();
      boxRef.current = null;
    };
  };

  const resource = {
    _tag: "attachment" as const,
    attachmentId: app.attachmentId,
    fileName: mcpAppFileName(app),
    mimeType: "text/html",
    disposition: "inline" as const,
    renderIntent: "mcp-app" as const,
  };
  // The frame keeps its first URL: a re-minted one would reload the app.
  const [src, setSrc] = useState<string | null>(null);
  const asset = useLongLivedAssetUrl(src === null ? props.environmentId : null, resource);
  if (src === null && asset._tag === "Success") setSrc(asset.url);

  const detail = useTurnItemDetail({
    environmentId: props.environmentId,
    threadId: props.threadId,
    itemId: props.itemId,
    revision: props.revision,
  });
  const storedItem = detail.data?.item;
  // Keep tool-call identity stable for the host's delivery effect.
  const toolCall =
    storedItem?.type === "dynamic_tool"
      ? {
          arguments: storedItem.input,
          result: (storedItem.output as { readonly result?: unknown } | undefined)?.result as
            | McpAppCallToolResult
            | undefined,
        }
      : undefined;

  const callTool = useAtomCommand(mcpAppEnvironment.callTool, { reportFailure: false });
  const toolInfo = useAtomCommand(mcpAppEnvironment.toolInfo, { reportFailure: false });
  const toolDefinition = useEnvironmentQuery(
    mcpAppEnvironment.toolInfoQuery({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, itemId: props.itemId, name: app.tool },
    }),
  ).data?.tool;
  const readResource = useAtomCommand(mcpAppEnvironment.readResource, { reportFailure: false });
  const updateModelContext = useAtomCommand(mcpAppEnvironment.updateModelContext, {
    reportFailure: false,
  });

  // Read live values without rebuilding the host and losing the app session.
  const readLive = useStableCallback(() => ({
    theme,
    width,
    props,
    callTool,
    toolInfo,
    readResource,
    updateModelContext,
    displayMode,
    toolDefinition,
  }));
  const hostRef = useRef<McpAppHost | null>(null);

  const [stepAsideFor, setStepAsideFor] = useState(props.awaitingUser);
  if (stepAsideFor !== props.awaitingUser) {
    setStepAsideFor(props.awaitingUser);
    if (props.awaitingUser === true) setDisplayMode("inline");
  }
  // The box is in the top layer exactly while its full-screen chrome is
  // mounted, so every way out of full screen (including the step-aside above,
  // decided during render) closes the popover and releases the timeline pin.
  const attachFullscreenChrome = (chrome: HTMLDivElement) => {
    const box = chrome.parentElement;
    if (box === null) return;
    if (!box.matches(":popover-open")) box.showPopover();
    readLive().props.onFullscreenChange?.(true);
    return () => {
      if (box.matches(":popover-open")) box.hidePopover();
      readLive().props.onFullscreenChange?.(false);
    };
  };
  // Light dismiss (Escape) closes the popover without React.
  const onBoxToggle = (event: ToggleEvent<HTMLDivElement>) => {
    if (event.newState === "closed") setDisplayMode("inline");
  };
  const onBoxBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (
      displayMode === "fullscreen" &&
      next instanceof Node &&
      !event.currentTarget.contains(next)
    ) {
      setDisplayMode("inline");
    }
  };

  // Navigation retains the frame window; reject second loads to prevent impersonation.
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

  // The host belongs to this frame element, which is replaced when the document is reopened.
  const attachFrame = (frame: HTMLIFrameElement) => {
    frameRef.current = frame;
    const hostContext = (): McpAppHostContext => {
      const current = readLive();
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
    // Return inline so approvals stay visible above the app.
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
      const { environmentId, threadId, itemId } = readLive().props;
      return { environmentId, input: { threadId, itemId } };
    };
    const host = makeMcpAppHost({
      app,
      hostVersion: APP_VERSION,
      // Opaque origins require "*"; the window reference scopes delivery to this frame.
      post: (message) => target()?.postMessage(message, "*"),
      hostContext,
      callTool: async ({ name, arguments: args }) => {
        const { environmentId, input } = scope();
        const info = await readLive().toolInfo({ environmentId, input: { ...input, name } });
        if (info._tag !== "Success") throw commandFailure(info);
        if (!info.value.callable) throw new McpAppHostRefusal("This app cannot call that tool.");
        if (!info.value.readOnly) {
          const approved = await ask(
            `Allow ${app.server} to run ${info.value.title ?? name}?\n${JSON.stringify(args, null, 2)}`,
          );
          if (approved !== true) throw new McpAppHostRefusal("Declined by the user.");
        }
        const result = await readLive().callTool({
          environmentId,
          input: { ...input, name, arguments: args },
        });
        if (result._tag !== "Success") throw commandFailure(result);
        return result.value;
      },
      readResource: async ({ uri }) => {
        const { environmentId, input } = scope();
        const result = await readLive().readResource({
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
        const send = readLive().props.onSendMessage;
        if (send === undefined) throw new McpAppHostRefusal("Messages are not available here.");
        const approved = await ask(`Send this message from ${app.server}?\n${text}`);
        if (approved !== true) throw new McpAppHostRefusal("Declined by the user.");
        await send(text);
      },
      updateModelContext: async (context) => {
        const { environmentId, input } = scope();
        const result = await readLive().updateModelContext({
          environmentId,
          input: {
            ...input,
            ...context,
            conversationThreadId: readLive().props.conversationThreadId,
          },
        });
        if (result._tag !== "Success") throw commandFailure(result);
      },
      requestDisplayMode: async (mode) => {
        const otherFullscreen = document.querySelector("[data-mcp-app-fullscreen]");
        if (
          mode === "fullscreen" &&
          (!fullscreenSupported ||
            document.activeElement !== frameRef.current ||
            !navigator.userActivation?.isActive ||
            performance.now() - lastPageInputAt < PAGE_ACTIVATION_MS ||
            readLive().props.awaitingUser === true ||
            isConfirmDialogActive() ||
            (otherFullscreen !== null && otherFullscreen !== boxRef.current))
        ) {
          return readLive().displayMode;
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
            const read = await readLive().readResource({
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
        if (readLive().displayMode === "fullscreen") {
          setDisplayMode("inline");
          return;
        }
        void host.teardown().then(() => setClosed(true));
      },
      onSizeChanged: (size) => {
        // Ignore fullscreen height when restoring inline sizing.
        if (readLive().displayMode === "fullscreen") return;
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
      frameRef.current = null;
    };
  };

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
    // Preserve inline row height during fullscreen to prevent timeline jumps.
    <div style={{ height }}>
      <div
        ref={attachBox}
        // Preserve the frame's parent to avoid reloads; the top layer escapes timeline containment.
        {...(fullscreenSupported
          ? { popover: "auto" as const, onToggle: onBoxToggle, onBlur: onBoxBlur }
          : {})}
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
          <div
            ref={attachFullscreenChrome}
            className="flex h-10 shrink-0 items-center justify-between border-border border-b px-3 text-sm"
          >
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
            ref={attachFrame}
            src={src}
            title={`${app.server} app`}
            // Omitting allow-same-origin isolates the app from the session.
            sandbox="allow-scripts allow-forms"
            allow={mcpAppAllowAttribute(app.permissions)}
            onLoad={onFrameLoad}
            className={cn("block w-full border-0", fullscreen ? "min-h-0 flex-1" : "h-full")}
            style={{ colorScheme: theme.appearance }}
          />
        ) : asset._tag === "Failure" ? (
          <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
            Unable to load the {app.server} app
          </p>
        ) : null}
      </div>
    </div>
  );
}
