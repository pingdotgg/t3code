// Relays the Laravel Toolbar's data to T3, which draws the bar under the page: the page's own
// `__LARAVEL_TOOLBAR_DATA__` and `laravel-toolbar:update` events (shared `window`), or, for
// pages with a CSP, the response-header payloads from main (ResponseHeaderRelay.ts).
// Channel and message shape: apps/web/src/laravelToolbar/bridge.ts.
import type { ToolbarHeaderPayload } from "@t3tools/shared/laravelToolbarHeaders";
import { ipcRenderer } from "electron";

import {
  LARAVEL_TOOLBAR_DOCUMENT_CHANNEL,
  LARAVEL_TOOLBAR_RESPONSE_CHANNEL,
} from "./GuestProtocol.ts";

const CHANNEL = "laravel-toolbar";

/** Structured clone needs plain data; the payload is JSON but may carry page objects. */
function plain(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function send(kind: "page" | "page-summary" | "update" | "none", data?: unknown) {
  ipcRenderer.sendToHost(CHANNEL, { kind, data: data === undefined ? undefined : plain(data) });
}

const summary = (payload: Extract<ToolbarHeaderPayload, { kind: "summary" }>) => ({
  request_id: payload.id,
  history_row: payload.row,
});

// Hosted mode (laravel-toolbar 0.3.7+): the page's toolbar keeps reporting requests but
// draws no bar of its own. The preload runs before page scripts and shares their window.
// Older versions still draw it; the host hides it with CSS (see apps/web laravelToolbar/bridge.ts).
// oxlint-disable-next-line t3code/no-hardcoded-app-name -- host id the laravel-toolbar package checks
(window as { __LARAVEL_TOOLBAR_HOST__?: string }).__LARAVEL_TOOLBAR_HOST__ = "T3 Code";

// Header payloads of fetches made before DOMContentLoaded wait until the document's source
// is known. A page with its own toolbar reports those requests itself.
let headerUpdates: "pending" | "relay" | "ignore" = "pending";
const pendingUpdates: ToolbarHeaderPayload[] = [];

const relayUpdate = (payload: ToolbarHeaderPayload) =>
  send("update", payload.kind === "full" ? payload.data : summary(payload));

ipcRenderer.on(LARAVEL_TOOLBAR_RESPONSE_CHANNEL, (_event, payload: ToolbarHeaderPayload) => {
  if (headerUpdates === "relay") relayUpdate(payload);
  else if (headerUpdates === "pending") pendingUpdates.push(payload);
});

window.addEventListener("DOMContentLoaded", () => {
  const data = (window as { __LARAVEL_TOOLBAR_DATA__?: unknown }).__LARAVEL_TOOLBAR_DATA__;
  if (data && typeof data === "object") {
    headerUpdates = "ignore";
    pendingUpdates.length = 0;
    send("page", data);
    return;
  }
  void ipcRenderer
    .invoke(LARAVEL_TOOLBAR_DOCUMENT_CHANNEL)
    .catch(() => null)
    .then((payload: ToolbarHeaderPayload | null) => {
      if (payload?.kind === "full") send("page", payload.data);
      else if (payload?.kind === "summary") send("page-summary", summary(payload));
      else send("none");
      headerUpdates = "relay";
      for (const update of pendingUpdates.splice(0)) relayUpdate(update);
    });
});

window.addEventListener("laravel-toolbar:update", (event) => {
  const data = (event as CustomEvent<{ data?: unknown }>).detail?.data;
  if (data && typeof data === "object") send("update", data);
});
