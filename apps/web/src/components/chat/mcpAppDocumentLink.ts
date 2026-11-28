import { MCP_APP_DOCUMENT_MESSAGE } from "@t3tools/shared/mcpApp";

const MAX_UNCONFIRMED_MESSAGES = 256;

interface DocumentLink {
  // `null` until the document's port or a JSON-RPC message arrives, `false` if the message came first.
  link: MessagePort | false | null;
  nextProbe: number;
  deliver: (data: unknown) => void;
  onMissing: () => void;
  readonly unconfirmed: Map<number, unknown>;
}

// Kept per frame, not per host: a host that re-attaches to the same frame must not take the
// frame's next message for a first one.
const documentLinks = new WeakMap<HTMLIFrameElement, DocumentLink>();

/**
 * Ties the bridge to the frame's first document. A frame's window outlives its document, so the
 * bridge follows the port that document's bootstrap sends first, not the window. A frame that
 * posts JSON-RPC before that port was served without the bootstrap and gets no bridge:
 * `onMissing` reports it and nothing is delivered or posted.
 */
export function attachMcpAppDocumentLink(
  frame: HTMLIFrameElement,
  deliver: (data: unknown) => void,
  onMissing: () => void,
) {
  let state = documentLinks.get(frame);
  if (state === undefined) {
    state = { link: null, nextProbe: 0, deliver, onMissing, unconfirmed: new Map() };
    documentLinks.set(frame, state);
  }
  const current = state;
  current.deliver = deliver;
  current.onMissing = onMissing;
  return {
    receive: (event: MessageEvent) => {
      if (event.source === null || event.source !== frame.contentWindow) return;
      if (current.link === false) return;
      if (current.link === null) {
        const port = event.data?.t3 === MCP_APP_DOCUMENT_MESSAGE ? (event.ports[0] ?? null) : null;
        // A script a local proxy injects ahead of the bootstrap may post first; only the app's
        // own JSON-RPC before the handover shows the bootstrap is missing.
        if (port === null && event.data?.jsonrpc !== "2.0") return;
        if (port === null) {
          current.link = false;
          current.onMissing();
          return;
        }
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
      // Only the first document can answer, so a reply proves it sent this message.
      if (current.unconfirmed.size >= MAX_UNCONFIRMED_MESSAGES) return;
      current.unconfirmed.set(current.nextProbe, event.data);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A MessagePort takes no target origin.
      current.link.postMessage({ alive: current.nextProbe });
      current.nextProbe += 1;
    },
    post: (message: unknown) => {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A MessagePort takes no target origin.
      if (current.link) current.link.postMessage({ message, origin: window.location.origin });
    },
  };
}
