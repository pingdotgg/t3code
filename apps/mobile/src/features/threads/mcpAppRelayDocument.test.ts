import { MCP_APP_DOCUMENT_MESSAGE } from "@t3tools/shared/mcpApp";
import { expect, it } from "vite-plus/test";

import { mcpAppRelayDocument } from "./mcpAppRelayDocument";

const SECRET = "secret";
const REQUEST = { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://a" } };

type Listener = (event: unknown) => void;

// Runs the relay page's script against stand-ins for the page, its app frame and React Native.
function runRelay() {
  const html = mcpAppRelayDocument("https://environment.test/app", "", SECRET);
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
  const relayed: Array<unknown> = [];
  const toFrameWindow: Array<unknown> = [];
  const listeners = new Map<string, Listener>();
  const frameWindow = {
    postMessage: (message: unknown) => {
      toFrameWindow.push(message);
    },
  };
  const frame = {
    contentWindow: frameWindow,
    src: "",
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(`frame:${type}`, listener);
    },
  };
  const page = {
    ReactNativeWebView: {
      postMessage: (text: string) => {
        const envelope = JSON.parse(text) as { readonly secret: string; readonly message: unknown };
        if (envelope.secret === SECRET) relayed.push(envelope.message);
      },
    },
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, listener);
    },
    __t3McpAppReceive: undefined as ((message: unknown) => void) | undefined,
  };
  // The relay exists only as page source; this runs that source.
  new Function("window", "document", "navigator", "location", script)(
    page,
    { getElementById: () => frame, activeElement: null },
    {},
    { origin: "null" },
  );
  return {
    relayed,
    toFrameWindow,
    fromFrame: (data: unknown, ports: ReadonlyArray<unknown> = []) =>
      listeners.get("message")!({ source: frameWindow, data, ports }),
    frameLoaded: () => listeners.get("frame:load")!({}),
    toApp: (message: unknown) => page.__t3McpAppReceive!(message),
  };
}

it("relays nothing for a frame whose document did not hand over a port", () => {
  const relay = runRelay();
  relay.frameLoaded();

  relay.fromFrame(REQUEST);
  expect(relay.relayed).toEqual([{ t3: "unlinked" }]);

  // The frame's next page gets the same window, and nothing more.
  relay.frameLoaded();
  relay.fromFrame({ ...REQUEST, id: 2 });
  relay.fromFrame({ t3: MCP_APP_DOCUMENT_MESSAGE }, [{ postMessage: () => {} }]);
  relay.fromFrame({ ...REQUEST, id: 3 });
  relay.toApp({ jsonrpc: "2.0", id: 1, result: {} });
  expect(relay.relayed).toEqual([{ t3: "unlinked" }]);
  expect(relay.toFrameWindow).toEqual([]);
});

it("relays a message once the document that handed over the port confirms it", () => {
  const relay = runRelay();
  const toPort: Array<unknown> = [];
  const port = {
    onmessage: undefined as Listener | undefined,
    postMessage: (message: unknown) => {
      toPort.push(message);
    },
  };

  relay.fromFrame({ t3: MCP_APP_DOCUMENT_MESSAGE }, [port]);
  relay.fromFrame(REQUEST);
  expect(relay.relayed).toEqual([]);
  expect(toPort).toEqual([{ alive: 0 }]);

  port.onmessage!({ data: { alive: 0 } });
  expect(relay.relayed).toEqual([REQUEST]);

  relay.toApp({ jsonrpc: "2.0", id: 1, result: {} });
  expect(toPort[1]).toEqual({ message: { jsonrpc: "2.0", id: 1, result: {} }, origin: "null" });
  expect(relay.toFrameWindow).toEqual([]);
});
