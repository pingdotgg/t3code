import {
  htmlRenderError,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  htmlRenderResult,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
  readHtmlRenderMessageRequest,
} from "@t3tools/shared/htmlRender";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { cn } from "~/lib/utils";

/**
 * Chromium's viewer opens with its own toolbar, a thumbnail rail and a small
 * zoom. The panel header is the only chrome we want, so ask for the page
 * alone, fitted to the panel width. Pinch and keyboard zoom, scrolling, text
 * selection and find still work inside the frame.
 */
const PDF_VIEWER_FRAGMENT = "#toolbar=0&view=FitH";

export const isPdfPreviewFile = (path: string): boolean =>
  /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");

/**
 * Renders an HTML or PDF document from its URL. HTML runs in a sandboxed frame
 * with an opaque origin, so a page cannot reach the app's session or storage.
 * The built-in PDF viewer needs an unsandboxed frame; a PDF runs no scripts.
 * An agent's HTML render also wears the app theme.
 */
export function BrowserDocumentFrame(props: {
  readonly src: string;
  readonly title: string;
  readonly pdf: boolean;
  readonly htmlRender?: boolean;
  /** Sends a render's `t3.send` text to its thread; renders refuse it without one. */
  readonly onSendMessage?: ((text: string) => Promise<void>) | undefined;
}) {
  const className = "min-h-0 flex-1 border-0 bg-white";
  return props.pdf ? (
    // oxlint-disable-next-line react/iframe-missing-sandbox -- the built-in PDF viewer needs an unsandboxed frame.
    <iframe
      key={props.src}
      src={`${props.src}${PDF_VIEWER_FRAGMENT}`}
      title={props.title}
      className={className}
    />
  ) : props.htmlRender ? (
    <HtmlRenderDocument
      key={props.src}
      src={props.src}
      title={props.title}
      className="min-h-0 flex-1"
      onSendMessage={props.onSendMessage}
    />
  ) : (
    <iframe
      key={props.src}
      src={props.src}
      title={props.title}
      className={className}
      sandbox="allow-scripts allow-forms allow-popups"
    />
  );
}

/**
 * A sandboxed agent HTML render in the app theme. The page reads the theme from
 * its URL fragment before first paint, then follows changes posted to its
 * bootstrap. The first URL is kept for the frame's lifetime: signed asset URLs
 * re-mint while it stays mounted, and a new src would reload the page.
 */
export function HtmlRenderDocument(props: {
  readonly src: string;
  readonly title: string;
  readonly className?: string;
  /** Receives the page's content height whenever it changes, so an inline frame can fit it. */
  readonly onContentHeight?: (height: number) => void;
  /** Sends a render's `t3.send` text to its thread; renders refuse it without one. */
  readonly onSendMessage?: ((text: string) => Promise<void>) | undefined;
}) {
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [src] = useState(() => `${props.src.split("#", 1)[0]}${htmlRenderThemeFragment(theme)}`);
  const [loaded, setLoaded] = useState(false);
  const postTheme = () => {
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  };
  useEffect(postTheme, [theme]);
  // The page cannot open windows itself (an inline page runs unopened, and
  // desktop sends any window to the browser). It asks the client, which opens
  // the link only while this frame has focus and the reader has just used the
  // app. A page can take focus by script, so this stops opens on load, not a
  // page that waits for the reader's next click or key.
  useEffect(() => {
    const openLink = (event: MessageEvent) => {
      const frame = frameRef.current;
      const request = readHtmlRenderLinkRequest(event.data);
      if (
        request === undefined ||
        frame === null ||
        event.source !== frame.contentWindow ||
        document.activeElement !== frame ||
        navigator.userActivation?.isActive === false
      ) {
        return;
      }
      window.open(request.url, "_blank", "noopener,noreferrer");
      frame.contentWindow?.postMessage(htmlRenderResult(request.id), "*");
    };
    window.addEventListener("message", openLink);
    return () => window.removeEventListener("message", openLink);
  }, []);
  // The agent wrote this page in the reader's own thread, so a button in it
  // works like a quick reply: the text sends as the reader's message with no
  // confirmation, under the same click-in-this-frame rule as links. User
  // activation lasts a few seconds, so a page also gets one message per second,
  // which keeps a looping page from flooding the thread.
  const { onSendMessage } = props;
  useEffect(() => {
    let lastSentAt = 0;
    const send = (event: MessageEvent) => {
      const frame = frameRef.current;
      const request = readHtmlRenderMessageRequest(event.data);
      if (request === undefined || frame === null || event.source !== frame.contentWindow) return;
      const reply = (message: unknown) => frame.contentWindow?.postMessage(message, "*");
      if (onSendMessage === undefined) {
        reply(htmlRenderError(request.id, "Messages are not available here."));
        return;
      }
      if (document.activeElement !== frame || navigator.userActivation?.isActive === false) {
        reply(htmlRenderError(request.id, "Messages send only from a click in the page."));
        return;
      }
      if (Date.now() - lastSentAt < 1_000) {
        reply(htmlRenderError(request.id, "Send one message per click."));
        return;
      }
      lastSentAt = Date.now();
      onSendMessage(request.text).then(
        () => reply(htmlRenderResult(request.id)),
        (error: unknown) =>
          reply(
            htmlRenderError(
              request.id,
              error instanceof Error ? error.message : "The message was not sent.",
            ),
          ),
      );
    };
    window.addEventListener("message", send);
    return () => window.removeEventListener("message", send);
  }, [onSendMessage]);
  const { onContentHeight } = props;
  // A page posts its height once per change, so listen from the commit that
  // inserts the frame; a passive effect could run after a fast page's first post.
  useLayoutEffect(() => {
    if (onContentHeight === undefined) return;
    const resize = (event: MessageEvent) => {
      const height = readHtmlRenderContentHeight(event.data);
      if (height !== undefined && event.source === frameRef.current?.contentWindow) {
        onContentHeight(height);
      }
    };
    window.addEventListener("message", resize);
    return () => window.removeEventListener("message", resize);
  }, [onContentHeight]);
  return (
    <iframe
      ref={frameRef}
      src={src}
      title={props.title}
      // Never allow-same-origin: the opaque origin keeps the page out of the app's session.
      sandbox="allow-scripts allow-forms"
      loading="lazy"
      onLoad={() => {
        setLoaded(true);
        // Covers a theme change that landed while the page was loading.
        postTheme();
      }}
      // A frame whose color scheme differs from its document's paints an opaque
      // canvas, so the blank document a frame starts with would flash white in
      // dark mode. Once the page is in, its prefers-color-scheme follows the app.
      className={cn("border-0 scheme-light", props.className)}
      style={loaded ? { colorScheme: theme.appearance } : undefined}
    />
  );
}
