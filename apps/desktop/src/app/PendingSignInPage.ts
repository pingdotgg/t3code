// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Native loopback page uses a bounded Node listener with timer cleanup.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

/**
 * A browser tab opened when the user starts a sign-in whose link is not ready yet. Antigravity's
 * runtime can take about a minute to print its Google link, so the tab shows that sign-in is
 * starting and forwards to the link once the renderer supplies it.
 */
interface PendingPage {
  readonly server: NodeHttp.Server;
  state:
    | { readonly _tag: "Waiting" }
    | { readonly _tag: "Ready"; readonly url: string }
    | {
        readonly _tag: "Ended";
      };
  timer: ReturnType<typeof setTimeout> | undefined;
}

// Matches the server's five-minute sign-in expiry with a little slack.
const PAGE_LIFETIME_MS = 330_000;
// Long enough for the page's next refresh to pick up the final state.
const SETTLED_LIFETIME_MS = 60_000;
const MAX_PAGES = 4;
const pages = new Map<string, PendingPage>();
let opening = 0;

/** The normalized link, or null unless it is Google's OAuth endpoint. */
const googleSignInHref = (raw: string) => {
  try {
    const url = new URL(raw);
    return url.origin === "https://accounts.google.com" &&
      url.pathname === "/o/oauth2/v2/auth" &&
      url.username === "" &&
      url.password === ""
      ? url.href
      : null;
  } catch {
    return null;
  }
};

const page = (title: string, body: string, refresh: boolean) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">${refresh ? '<meta http-equiv="refresh" content="1">' : ""}<title>${title} · T3 Code</title><style>body{font-family:system-ui;display:grid;place-items:center;min-height:90vh;margin:0}main{max-width:360px;padding:32px}h1{font-size:24px}p{line-height:1.6;opacity:.7}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

const WAITING_PAGE = page(
  "Starting sign-in",
  "This page continues to Google when sign-in is ready. It can take about a minute.",
  true,
);
const ENDED_PAGE = page(
  "Sign-in stopped",
  "Return to T3 Code to see what happened or try again. You can close this tab.",
  false,
);

function closePage(id: string) {
  const pending = pages.get(id);
  if (!pending) return;
  pages.delete(id);
  clearTimeout(pending.timer);
  pending.server.closeAllConnections();
  pending.server.close();
}

function scheduleClose(id: string, pending: PendingPage, ms: number) {
  clearTimeout(pending.timer);
  if (ms <= 0) {
    closePage(id);
    return;
  }
  pending.timer = setTimeout(() => closePage(id), ms);
  pending.timer.unref();
}

/** Opens the browser on a local page now and returns its id for `settlePendingSignInPage`. */
export async function openPendingSignInPage(
  openBrowser: (url: string) => Promise<boolean>,
  lifetimeMs = PAGE_LIFETIME_MS,
  settledLifetimeMs = SETTLED_LIFETIME_MS,
): Promise<string> {
  if (pages.size + opening >= MAX_PAGES) throw new Error("Too many sign-in pages are open.");
  opening += 1;
  try {
    return await openPage(openBrowser, lifetimeMs, settledLifetimeMs);
  } finally {
    opening -= 1;
  }
}

async function openPage(
  openBrowser: (url: string) => Promise<boolean>,
  lifetimeMs: number,
  settledLifetimeMs: number,
): Promise<string> {
  const id = NodeCrypto.randomBytes(32).toString("base64url");
  const server = NodeHttp.createServer((incoming, response) => {
    const current = pages.get(id);
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    // The Host check keeps a DNS-rebound site from reading the page even if it guessed the path.
    if (
      !current ||
      incoming.method !== "GET" ||
      incoming.url !== `/${id}` ||
      incoming.headers.host !== `127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`
    ) {
      response.writeHead(404).end();
      return;
    }
    if (current.state._tag === "Ready") {
      response.writeHead(303, { location: current.state.url }).end();
      return;
    }
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    );
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(current.state._tag === "Waiting" ? WAITING_PAGE : ENDED_PAGE);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const pending: PendingPage = { server, state: { _tag: "Waiting" }, timer: undefined };
  pages.set(id, pending);
  // A renderer that reloads mid-sign-in never settles the page; show that it stopped, then close.
  pending.timer = setTimeout(() => {
    pending.state = { _tag: "Ended" };
    scheduleClose(id, pending, settledLifetimeMs);
  }, lifetimeMs);
  pending.timer.unref();
  const { port } = server.address() as NodeNet.AddressInfo;
  const opened = await Promise.resolve()
    .then(() => openBrowser(`http://127.0.0.1:${port}/${id}`))
    .catch(() => false);
  if (!opened) {
    closePage(id);
    throw new Error("Could not open your browser.");
  }
  return id;
}

/**
 * Forwards the page to a Google sign-in link, or shows that sign-in stopped when the link is null.
 * Only Google's OAuth endpoint is accepted, so the page cannot become an open redirect.
 */
export function settlePendingSignInPage(
  id: string,
  authorizationUrl: string | null,
  settledLifetimeMs = SETTLED_LIFETIME_MS,
) {
  const pending = pages.get(id);
  if (!pending) return;
  const url = authorizationUrl === null ? null : googleSignInHref(authorizationUrl);
  if (authorizationUrl !== null && url === null) {
    throw new Error("Only a Google sign-in link can be opened.");
  }
  pending.state = url === null ? { _tag: "Ended" } : { _tag: "Ready", url };
  scheduleClose(id, pending, settledLifetimeMs);
}
