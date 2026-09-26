/**
 * Empty-state "Local servers" section on the public
 * `t3.browser/local-servers` stream. The native panel's
 * PreviewEmptyState renders "Recently used" (≤ 8) and then "Local servers";
 * this module owns the section's model: snapshot → sorted, deduped rows, and
 * every way the stream can end → a named state, never a silent empty list.
 *
 * The stream carries only environment loopback origins (`url` + `port`) — no
 * process name or configured-URL enrichment — so every row is the native
 * card's unenriched form: title "Listening", description `host:port`.
 */
import {
  BROWSER_READ_LOCAL_SERVERS,
  type BrowserLocalServersEvent,
} from "@t3tools/extension-sdk/catalogue";

export interface LocalServerRow {
  /** The loopback URL the row opens — submitted exactly like a typed address. */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly title: string;
  readonly description: string;
}

export type LocalServersState =
  /** Not subscribed: the empty state is hidden or a session is held. */
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly servers: readonly LocalServerRow[];
      readonly truncated: boolean;
    }
  /** The environment's port scanner went away (`closed: source-unavailable`). */
  | { readonly kind: "closed"; readonly message: string }
  /** The installation lacks `t3.browser/read-local-servers`. */
  | { readonly kind: "denied"; readonly grant: string; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

/** Native footer copy under the section. */
export const LOCAL_SERVERS_HINT = "Select a live local server to open it in this browser tab.";

/**
 * Native re-maps a discovered loopback URL to a remote environment's host
 * before opening it (`resolveDiscoveredServerUrl`). `t3.browser/sessions`
 * forwards the URL to the engine verbatim, and the SDK tells a plugin
 * neither the environment's origin nor whether it is remote — so the
 * difference is named instead of hidden behind a link that could reach the
 * wrong machine.
 */
export const LOCAL_SERVERS_LOOPBACK_LIMITATION =
  "Opened as-is: for a remote environment, localhost reaches the machine running the browser, not the environment.";

export const LOCAL_SERVERS_TRUNCATED_NOTICE =
  "Some discovered servers are not listed — the environment reported more than it could share.";

/** Native "No preview yet" copy — shown when nothing else is listed. */
export const NO_PREVIEW_TITLE = "No preview yet";
export const NO_PREVIEW_DESCRIPTION =
  "Type a URL above, or run a dev script. Browser-ready localhost servers will show up here automatically.";
/** Same empty state when discovery cannot run — never promise servers will appear. */
export const NO_PREVIEW_DESCRIPTION_WITHOUT_DISCOVERY = "Type a URL above.";

const LOOPBACK_KEY_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

function loopbackKey(host: string, port: number): string {
  const normalized = host.toLowerCase();
  return `${LOOPBACK_KEY_HOSTS.has(normalized) ? "loopback" : normalized}:${port}`;
}

/**
 * Snapshot → rows. Native's scanner list is keyed by host:port with every
 * loopback alias folded together, then sorted by port; a malformed entry is
 * dropped and marks the list truncated rather than rendering a dead row.
 */
export function localServersFromSnapshot(
  snapshot: Extract<BrowserLocalServersEvent, { readonly kind: "snapshot" }>,
): Extract<LocalServersState, { readonly kind: "ready" }> {
  let truncated = snapshot.truncated;
  const byKey = new Map<string, LocalServerRow>();
  for (const server of snapshot.servers) {
    let parsed: URL;
    try {
      parsed = new URL(server.url);
    } catch {
      truncated = true;
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      truncated = true;
      continue;
    }
    const key = loopbackKey(parsed.hostname, server.port);
    const existing = byKey.get(key);
    // Prefer `localhost`: Chromium's dual-stack lookup reaches servers bound
    // only to ::1 or only to 127.0.0.1 (the native resolver's same choice).
    if (existing && !(parsed.hostname === "localhost" && existing.host !== "localhost")) continue;
    byKey.set(key, {
      url: parsed.href,
      host: parsed.hostname,
      port: server.port,
      title: "Listening",
      description: `${parsed.hostname}:${server.port}`,
    });
  }
  const servers = [...byKey.values()].toSorted(
    (left, right) => left.port - right.port || left.url.localeCompare(right.url),
  );
  return { kind: "ready", servers, truncated };
}

/**
 * A failed subscribe → named state. The broker names a missing grant as
 * `API capability denied: <grant>`; anything else is reported with its detail.
 */
export function localServersErrorState(
  error: unknown,
): Extract<LocalServersState, { readonly kind: "denied" | "unavailable" }> {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("capability denied"))
    return {
      kind: "denied",
      grant: BROWSER_READ_LOCAL_SERVERS,
      message: `Local servers are hidden — this installation is missing the ${BROWSER_READ_LOCAL_SERVERS} grant.`,
    };
  return {
    kind: "unavailable",
    message: `Local servers are unavailable${text ? ` — ${text.slice(0, 300)}` : ""}.`,
  };
}

export const LOCAL_SERVERS_CLOSED_MESSAGE =
  "Local server discovery stopped — the environment's port scanner is unavailable.";

type LocalServersStream = {
  subscribe(
    name: "subscribe",
    input: Record<string, never>,
    signal: AbortSignal,
  ): AsyncIterable<{ readonly value?: BrowserLocalServersEvent }>;
};

/**
 * Drives one subscription until `signal` aborts. Every snapshot replaces the
 * list; `closed` and an unexpected end are terminal named states. Nothing is
 * reported after abort, so a hidden or unmounted view never paints late.
 */
export async function watchLocalServers(
  api: LocalServersStream,
  signal: AbortSignal,
  onState: (state: LocalServersState) => void,
): Promise<void> {
  onState({ kind: "loading" });
  try {
    for await (const frame of api.subscribe("subscribe", {}, signal)) {
      if (signal.aborted) return;
      const value = frame.value;
      if (!value) continue;
      if (value.kind === "closed") {
        onState({ kind: "closed", message: LOCAL_SERVERS_CLOSED_MESSAGE });
        return;
      }
      onState(localServersFromSnapshot(value));
    }
    if (!signal.aborted)
      onState({ kind: "unavailable", message: "Local server discovery ended unexpectedly." });
  } catch (error) {
    if (!signal.aborted) onState(localServersErrorState(error));
  }
}

/**
 * What the empty state renders. Native shows "No preview yet" only when
 * both lists are empty; a local-servers state that is not a list (loading,
 * closed, denied, unavailable) is still named, so the reason is never lost.
 */
export function landingModel(input: {
  readonly recentCount: number;
  readonly localServers: LocalServersState;
}): {
  readonly noPreview: { readonly title: string; readonly description: string } | null;
  readonly serverList: readonly LocalServerRow[];
  readonly localNotice: string | null;
} {
  const local = input.localServers;
  const serverList = local.kind === "ready" ? local.servers : [];
  const failed = local.kind === "closed" || local.kind === "denied" || local.kind === "unavailable";
  const localNotice = failed
    ? local.message
    : local.kind === "ready" && local.truncated
      ? LOCAL_SERVERS_TRUNCATED_NOTICE
      : null;
  const noPreview =
    input.recentCount === 0 && serverList.length === 0
      ? {
          title: NO_PREVIEW_TITLE,
          description: failed ? NO_PREVIEW_DESCRIPTION_WITHOUT_DISCOVERY : NO_PREVIEW_DESCRIPTION,
        }
      : null;
  return { noPreview, serverList, localNotice };
}
