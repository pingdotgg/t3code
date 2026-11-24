import { MCP_APP_DOCUMENT_MESSAGE } from "@t3tools/shared/mcpApp";

const MAX_UNCONFIRMED_MESSAGES = 256;

interface DocumentLink {
  link: MessagePort | "window" | null;
  nextProbe: number;
  deliver: (data: unknown) => void;
  readonly unconfirmed: Map<number, unknown>;
}

// Kept per frame, not per host: a host that re-attaches to the same frame must not take the
// frame's next message for a first one.
const documentLinks = new WeakMap<HTMLIFrameElement, DocumentLink>();

/**
 * Ties the bridge to the frame's first document. A frame's window outlives its document, so the
 * bridge follows the port that document's bootstrap sends first, not the window. Servers without
 * the bootstrap keep the plain window bridge.
 */
export function attachMcpAppDocumentLink(
  frame: HTMLIFrameElement,
  deliver: (data: unknown) => void,
) {
  let state = documentLinks.get(frame);
  if (state === undefined) {
    state = { link: null, nextProbe: 0, deliver, unconfirmed: new Map() };
    documentLinks.set(frame, state);
  }
  const current = state;
  current.deliver = deliver;
  return {
    receive: (event: MessageEvent) => {
      if (event.source === null || event.source !== frame.contentWindow) return;
      if (current.link === null) {
        const port = event.data?.t3 === MCP_APP_DOCUMENT_MESSAGE ? (event.ports[0] ?? null) : null;
        if (port !== null) {
          current.link = port;
          port.onmessage = (reply: MessageEvent) => {
            const probe: unknown = reply.data?.alive;
            if (typeof probe !== "number" || !current.unconfirmed.has(probe)) return;
            const data = current.unconfirmed.get(probe);
            current.unconfirmed.delete(probe);
            current.deliver(data);
          };
          return;
        }
        current.link = "window";
      }
      if (current.link === "window") {
        current.deliver(event.data);
        return;
      }
      // Only the first document can answer, so a reply proves it sent this message.
      if (current.unconfirmed.size >= MAX_UNCONFIRMED_MESSAGES) return;
      current.unconfirmed.set(current.nextProbe, event.data);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A MessagePort takes no target origin.
      current.link.postMessage({ alive: current.nextProbe });
      current.nextProbe += 1;
    },
    post: (message: unknown) => {
      // Opaque origins require "*"; the window reference scopes delivery to this frame.
      if (current.link === "window") frame.contentWindow?.postMessage(message, "*");
      else current.link?.postMessage({ message, origin: window.location.origin });
    },
  };
}
