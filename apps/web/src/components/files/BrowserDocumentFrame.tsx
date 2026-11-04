import { useAtomValue } from "@effect/atom-react";
import {
  SIDE_CHAT_EXCERPT_MAX_CHARS,
  type KeybindingCommand,
  type KeybindingShortcut,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  type ScopedThreadRef,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";
import {
  type HtmlRenderShortcut,
  htmlRenderShortcutsMessage,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  htmlRenderResult,
  htmlRenderTextRequest,
  readHtmlRenderSelection,
  readHtmlRenderTextResult,
  readHtmlRenderContentHeight,
  readHtmlRenderImageRequest,
  readHtmlRenderKeyDown,
  readHtmlRenderLinkRequest,
} from "@t3tools/shared/htmlRender";
import {
  isMacPlatform,
  matchesKeybindingShortcut,
  normalizeEventKey,
} from "@t3tools/shared/keybindings";
import {
  lazy,
  Suspense,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useImperativeHandle,
  type Ref,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { MessageCircleQuestionIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AskInSideChatButton } from "../chat/AssistantSelectionToolbar";
import { isElectron } from "~/env";
import { FileSurfaceLoading } from "./fileSurfaceChrome";
import type { PdfViewState } from "./PdfViewer";

import { useOpenLink } from "~/browser/useOpenLink";
import { ExpandedImageDialog } from "~/components/chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "~/components/chat/ExpandedImagePreview";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { shortcutConflictKey } from "~/keybindings";
import { useOpenChangeRequestLink } from "~/lib/openPullRequestLink";
import { readLocalApi } from "~/localApi";
import { cn, randomUUID } from "~/lib/utils";
import { primaryServerKeybindingsAtom, serverEnvironment } from "~/state/server";

/**
 * The page reports the keys, and a page script can report any key it likes,
 * so only commands that change what the reader sees are here, never one that
 * changes a thread.
 */
const HTML_RENDER_SHORTCUT_COMMANDS: ReadonlySet<KeybindingCommand> = new Set([
  "commandPalette.toggle",
  "filePicker.toggle",
  "projectSearch.toggle",
  "chat.find",
  "sidebar.toggle",
  "rightPanel.toggle",
  "rightPanel.toggleMaximized",
  "threadPanel.toggle",
  "terminal.toggle",
  "preview.toggle",
  "navigation.back",
  "navigation.forward",
  "thread.previous",
  "thread.next",
  ...THREAD_JUMP_KEYBINDING_COMMANDS,
  ...MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
]);

export const isPdfPreviewFile = (path: string): boolean =>
  /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");

const PdfViewer = lazy(() => import("./PdfViewer"));

// The document stays mounted while each revision gets a fresh PDF.js document.
function PdfDocument(props: { src: string; title: string; documentKey: string }) {
  const [view, setView] = useState<PdfViewState>({ page: 0, offset: 0, zoom: null, left: 0 });
  return (
    <PdfDocumentRevision
      key={props.documentKey}
      src={props.src}
      title={props.title}
      positionKey={props.documentKey}
      initialView={view}
      onViewChange={setView}
    />
  );
}

// Keep signed URL renewals from reloading the same revision.
function PdfDocumentRevision(props: {
  src: string;
  title: string;
  positionKey: string;
  initialView: PdfViewState;
  onViewChange: (view: PdfViewState) => void;
}) {
  const [src] = useState(props.src);
  // The Electron shell does not enable PDF plugins. WebKit embeds on iOS
  // expose only the first page, even when pdfViewerEnabled reports support.
  const native =
    !isElectron &&
    navigator.pdfViewerEnabled &&
    !/iPad|iPhone|iPod/.test(navigator.userAgent) &&
    !(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return native ? (
    // oxlint-disable-next-line react/iframe-missing-sandbox -- Chromium's PDF plugin requires an unsandboxed frame; src is an exact-file asset grant.
    <iframe
      src={`${src.split("#", 1)[0]}#navpanes=0&view=FitH`}
      title={props.title}
      className="block h-full min-h-0 w-full flex-1 border-0 bg-white"
    />
  ) : (
    <Suspense fallback={<FileSurfaceLoading />}>
      <PdfViewer
        src={src}
        title={props.title}
        positionKey={props.positionKey}
        initialView={props.initialView}
        onViewChange={props.onViewChange}
      />
    </Suspense>
  );
}

/**
 * HTML runs in a sandboxed frame with an opaque origin, so a page cannot reach
 * the app's session or storage. PDFs use a native viewer or the lazy PDF.js fallback.
 */
export function BrowserDocumentFrame(props: {
  readonly src: string;
  readonly title: string;
  readonly pdf: boolean;
  readonly htmlRender?: boolean;
  readonly threadRef?: ScopedThreadRef | undefined;
  /** Stable resource identity and revision; defaults to src for callers that reload on URL changes. */
  readonly documentKey?: string | undefined;
  /** Resource identity without its revision, so PDF reloads can retain the reading position. */
  readonly documentId?: string | undefined;
}) {
  const key = props.documentKey ?? props.src;
  return props.pdf ? (
    <PdfDocument
      key={props.documentId ?? key}
      documentKey={key}
      src={props.src}
      title={props.title}
    />
  ) : props.htmlRender ? (
    <HtmlRenderDocument
      key={key}
      src={props.src}
      title={props.title}
      threadRef={props.threadRef}
      className="min-h-0 flex-1"
    />
  ) : (
    <FileDocument key={key} src={props.src} title={props.title} />
  );
}

// URL renewals must not discard form input or scroll; a new key mounts a fresh document.
function FileDocument(props: { readonly src: string; readonly title: string }) {
  const [src] = useState(props.src);
  return (
    <iframe
      src={src}
      title={props.title}
      className="min-h-0 flex-1 border-0 bg-white"
      sandbox="allow-scripts allow-forms allow-popups allow-downloads"
    />
  );
}

export interface HtmlRenderDocumentHandle {
  readonly askInSideChat: () => void;
}

export function HtmlRenderAskButton(props: {
  readonly onClick: () => void;
  readonly askPending?: boolean | undefined;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Ask in side chat"
            size="icon-xs"
            variant="glass"
            aria-disabled={props.askPending || undefined}
            aria-description={props.askPending ? "Starting side chat…" : undefined}
            onClick={() => {
              if (!props.askPending) props.onClick();
            }}
          />
        }
      >
        <MessageCircleQuestionIcon aria-hidden="true" className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="left">
        {props.askPending ? "Starting side chat…" : "Ask in side chat"}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Keep the initial URL while mounted; re-signing must not reload the page. */
export function HtmlRenderDocument({
  ref,
  ...props
}: {
  readonly ref?: Ref<HtmlRenderDocumentHandle>;
  readonly onAskInSideChat?: ((excerpt: string) => void) | undefined;
  readonly onBridgeReady?: () => void;
  readonly askPending?: boolean | undefined;
  readonly src: string;
  readonly title: string;
  readonly className?: string;
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly onContentHeight?: (height: number) => void;
  /** Reports fullscreen changes so virtualized rows can stay mounted. */
  readonly onFullscreenChange?: ((fullscreen: boolean) => void) | undefined;
}) {
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [src] = useState(() => `${props.src.split("#", 1)[0]}${htmlRenderThemeFragment(theme)}`);
  const [loaded, setLoaded] = useState(false);
  const [selection, setSelection] = useState<{
    text: string;
    x: number;
    y: number;
    overlay: HTMLElement | null;
  }>();
  const textRequestId = useRef<string | null>(null);
  useImperativeHandle(ref, () => ({
    askInSideChat: () => {
      textRequestId.current = randomUUID();
      frameRef.current?.contentWindow?.postMessage(
        htmlRenderTextRequest(textRequestId.current),
        "*",
      );
    },
  }));
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const postTheme = () => {
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- posts the current theme to the sandboxed iframe's window
  useEffect(postTheme, [theme]);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const environmentKeybindings = useAtomValue(
    serverEnvironment.configValueAtom(props.threadRef?.environmentId ?? null),
  )?.keybindings;
  // Replay only Cmd/Ctrl chords exclusive to allowed commands regardless of when; live resolution could
  // otherwise type in the composer.
  const mac = isMacPlatform(navigator.platform);
  const resolve = (shortcut: KeybindingShortcut): HtmlRenderShortcut => ({
    key: shortcut.key,
    metaKey: shortcut.metaKey || (shortcut.modKey && mac),
    ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !mac),
    shiftKey: shortcut.shiftKey,
    altKey: shortcut.altKey,
  });
  const blocked = [...keybindings, ...(environmentKeybindings ?? [])]
    .filter((binding) => !HTML_RENDER_SHORTCUT_COMMANDS.has(binding.command))
    .map((binding) => resolve(binding.shortcut));
  const shortcutsByKey = new Map<string, HtmlRenderShortcut>();
  for (const { command, shortcut } of keybindings) {
    if (
      HTML_RENDER_SHORTCUT_COMMANDS.has(command) &&
      (shortcut.metaKey || shortcut.ctrlKey || shortcut.modKey)
    ) {
      shortcutsByKey.set(shortcutConflictKey(shortcut), resolve(shortcut));
    }
  }
  const shortcuts = [...shortcutsByKey.values()];
  const postShortcuts = () => {
    frameRef.current?.contentWindow?.postMessage(
      htmlRenderShortcutsMessage(shortcuts, blocked),
      "*",
    );
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- posts allowed and blocked shortcuts to the sandboxed iframe's window
  useEffect(postShortcuts, [blocked, shortcuts]);
  // Pages can forge key/code pairs; reject pairs matching other bindings and require named keys to match the
  // shortcut.
  const isShortcut = useEffectEvent(
    (key: NonNullable<ReturnType<typeof readHtmlRenderKeyDown>>) => {
      const matches = (shortcut: HtmlRenderShortcut) =>
        matchesKeybindingShortcut(key, { ...shortcut, modKey: false }, navigator.platform);
      const allowed = shortcuts.filter(matches);
      return (
        allowed.length > 0 &&
        !blocked.some(matches) &&
        (key.key.length === 1 ||
          key.key === "Dead" ||
          allowed.some((shortcut) => shortcut.key === normalizeEventKey(key.key)))
      );
    },
  );
  const openChangeRequestLink = useOpenChangeRequestLink(props.threadRef);
  const openLink = useOpenLink(props.threadRef);
  const open = useEffectEvent((url: string, modifiers: { metaKey: boolean; ctrlKey: boolean }) => {
    if (modifiers.metaKey || modifiers.ctrlKey) {
      void readLocalApi()
        ?.shell.openExternal(url)
        .catch((cause: unknown) => console.error(cause));
      return;
    }
    if (
      props.threadRef !== undefined &&
      openChangeRequestLink(
        { ...modifiers, preventDefault: () => undefined, stopPropagation: () => undefined },
        url,
        undefined,
        props.threadRef.environmentId,
      )
    ) {
      return;
    }
    void openLink(url, { event: modifiers }).catch((cause: unknown) => console.error(cause));
  });
  const { onFullscreenChange } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports fullscreen to the parent while the image viewer is open, and clears it on unmount
  useEffect(() => {
    if (expandedImage === null) return;
    onFullscreenChange?.(true);
    return () => onFullscreenChange?.(false);
  }, [expandedImage, onFullscreenChange]);
  // Links, keys and images require frame focus and recent reader activity: a page can take
  // focus by script, so this blocks opens on load, though not a page that waits for the
  // reader's next input.
  const onFrameMessage = useEffectEvent((frame: HTMLIFrameElement, event: MessageEvent) => {
    const height = readHtmlRenderContentHeight(event.data);
    if (height !== undefined) {
      props.onContentHeight?.(height);
      return;
    }
    const textResult = readHtmlRenderTextResult(event.data);
    if (textResult !== undefined && textResult.id === textRequestId.current) {
      textRequestId.current = null;
      props.onAskInSideChat?.(
        `${props.title}\n\n${textResult.text}`.slice(0, SIDE_CHAT_EXCERPT_MAX_CHARS),
      );
      return;
    }
    const selected = readHtmlRenderSelection(event.data);
    if (selected !== undefined) props.onBridgeReady?.();
    if (selected?.text === "") {
      setSelection(undefined);
      return;
    }
    if (document.activeElement !== frame || navigator.userActivation?.isActive === false) return;
    if (selected !== undefined) {
      if (!props.onAskInSideChat) {
        setSelection(undefined);
        return;
      }
      const overlay = frame.closest<HTMLElement>(
        '[data-slot="dialog-popup"], [data-slot="sheet-popup"]',
      );
      const frameRect = frame.getBoundingClientRect();
      const overlayRect = overlay?.getBoundingClientRect();
      const scaleX = frame.clientWidth ? frameRect.width / frame.clientWidth : 1;
      const scaleY = frame.clientHeight ? frameRect.height / frame.clientHeight : 1;
      setSelection({
        text: selected.text,
        x:
          Math.max(
            8,
            Math.min(frameRect.left + selected.rect.x * scaleX, window.innerWidth - 220),
          ) - (overlayRect?.left ?? 0),
        y:
          Math.max(
            8,
            Math.min(frameRect.top + selected.rect.y * scaleY - 32, window.innerHeight - 40),
          ) - (overlayRect?.top ?? 0),
        overlay,
      });
      return;
    }
    const linkRequest = readHtmlRenderLinkRequest(event.data);
    if (linkRequest !== undefined) {
      open(linkRequest.url, linkRequest);
      frame.contentWindow?.postMessage(htmlRenderResult(linkRequest.id), "*");
      return;
    }
    const key = readHtmlRenderKeyDown(event.data);
    if (key !== undefined) {
      if (isShortcut(key)) {
        frame.dispatchEvent(
          new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }),
        );
      }
      return;
    }
    const imageRequest = readHtmlRenderImageRequest(event.data);
    if (imageRequest !== undefined) {
      setExpandedImage({ images: [{ src: imageRequest.src, name: imageRequest.name }], index: 0 });
    }
  });
  // Attach at commit because a fast page may post its initial height before passive effects run.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches a window message listener for the iframe at commit, before its first height post
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source === frame.contentWindow) onFrameMessage(frame, event);
    };
    const dismiss = () => setSelection(undefined);
    window.addEventListener("message", onMessage);
    window.addEventListener("focus", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, []);
  const tooLong = (selection?.text.length ?? 0) > SIDE_CHAT_EXCERPT_MAX_CHARS;
  return (
    <>
      {selection && props.onAskInSideChat
        ? createPortal(
            <div
              role="toolbar"
              aria-label="Selection actions"
              className={cn(selection.overlay ? "absolute" : "fixed", "z-50")}
              style={{ left: selection.x, top: selection.y }}
              onPointerDown={(event) => event.preventDefault()}
            >
              <AskInSideChatButton
                tooLong={tooLong}
                blockedReason={
                  tooLong
                    ? `Side chats take up to ${SIDE_CHAT_EXCERPT_MAX_CHARS.toLocaleString("en-US")} characters`
                    : props.askPending
                      ? "Starting side chat…"
                      : null
                }
                onClick={() => {
                  props.onAskInSideChat?.(selection.text);
                  setSelection(undefined);
                }}
              />
            </div>,
            selection.overlay ?? document.body,
          )
        : null}
      <iframe
        ref={frameRef}
        src={src}
        title={props.title}
        // Never allow-same-origin: the opaque origin keeps the page out of the app's session.
        sandbox="allow-scripts allow-forms"
        // Lets a page's video or image viewer take the screen.
        allow="fullscreen"
        loading="lazy"
        onLoad={() => {
          setLoaded(true);
          setSelection(undefined);
          // Covers a theme change that landed while the page was loading.
          postTheme();
          postShortcuts();
        }}
        // Match the blank document's scheme to avoid dark-mode white flashes, then follow the app after load.
        className={cn("border-0 scheme-light", props.className)}
        style={loaded ? { colorScheme: theme.appearance } : undefined}
      />
      {expandedImage !== null ? (
        <ExpandedImageDialog preview={expandedImage} onClose={() => setExpandedImage(null)} />
      ) : null}
    </>
  );
}
