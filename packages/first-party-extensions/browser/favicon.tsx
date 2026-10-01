/**
 * Favicon rendering for the Browser panel's surfaces, over the shared
 * per-origin cache (`faviconStore.ts`): the captured tier (session
 * `faviconRef`s resolved through `sessions.getFavicon`) ahead of the
 * public-provider tier. A load failure drops that tier for the origin on
 * every surface — the session tab strip, the recents list, the host tab —
 * together, so a dead image stops being requested.
 * No timer drives the provider retry: a surface that mounts or navigates
 * expires its origin's stale failure, and that render requests the provider
 * image once more.
 */
import type { BrowserSession, browserSessionsApi } from "@t3tools/extension-sdk/catalogue";
import { useEffect, useSyncExternalStore } from "react";

import { createFaviconReadQueue } from "./faviconReads.js";
import {
  type FaviconCache,
  type FaviconResolution,
  MAX_FAVICON_READS,
  applyResolvedFaviconRefs,
  dropCapturedFavicon,
  emptyFaviconCache,
  expireStaleFaviconFailure,
  faviconFallbackGlyph,
  pendingFaviconRefs,
  recordProviderFaviconFailure,
  recordResolvedFaviconRef,
  resolveFavicon,
} from "./faviconStore.js";
import type { BoundApi } from "./uiContracts.js";

const muted = "var(--t3-browser-muted-foreground, var(--muted-foreground, #667085))";

const listeners = new Set<() => void>();
let cache: FaviconCache = emptyFaviconCache();
let version = 0;

function commit(next: FaviconCache): void {
  if (next === cache) return;
  cache = next;
  version += 1;
  for (const listener of listeners) listener();
}

/** `<img onError>` entry point — shared by every surface's favicon. */
export function faviconImageFailed(
  rawUrl: string,
  shown: Extract<FaviconResolution, { kind: "image" }>,
): void {
  commit(
    shown.tier === "captured"
      ? dropCapturedFavicon(cache, rawUrl, shown.ref)
      : recordProviderFaviconFailure(cache, rawUrl, Date.now()),
  );
}

const reads = createFaviconReadQueue({
  maxInFlight: MAX_FAVICON_READS,
  settle: (ref, src) => commit(recordResolvedFaviconRef(cache, ref, src, Date.now())),
});

/**
 * Reads the sessions' new favicon refs, once each and at most
 * `MAX_FAVICON_READS` at a time; the rest queue and start as reads finish.
 * Driven by session events, never a timer. A miss (`BrowserFaviconNotFound`:
 * evicted, restarted server) or any other failure is recorded, so the ref is
 * not re-read and its origins stay on the provider tier; a read cancelled
 * with its view is dropped.
 */
export function resolveSessionFavicons(
  api: BoundApi<typeof browserSessionsApi>,
  sessions: readonly BrowserSession[],
  signal: AbortSignal,
): void {
  reads.request(
    pendingFaviconRefs(cache, sessions),
    (ref, readSignal) =>
      api.invoke("getFavicon", { ref }, readSignal).then((favicon) => favicon.dataUrl),
    signal,
  );
}

/**
 * Shows each session's resolved ref on its origin. Call when the sessions or
 * the rendered ref results (`cache.resolved`) change — not on every cache
 * change: applying writes only origin captures, never `resolved`, so it cannot
 * re-trigger itself, and the same sessions apply to the same cache. Results
 * that are no longer current are skipped; the newer ones render again.
 */
export function applySessionFavicons(
  rendered: FaviconCache["resolved"],
  sessions: readonly BrowserSession[],
): void {
  if (rendered === cache.resolved) commit(applyResolvedFaviconRefs(cache, sessions, Date.now()));
}

/** The current cache, re-read on every change. */
export function useFaviconCache(): FaviconCache {
  useSyncExternalStore(subscribe, () => version);
  return cache;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function useFaviconResolution(url: string | null, ref: string | null): FaviconResolution {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    commit(expireStaleFaviconFailure(cache, url, Date.now()));
  }, [url]);
  return resolveFavicon(cache, url, ref);
}

/**
 * One favicon slot: the tab's own captured `faviconRef` image, else the
 * origin's capture or provider image, else the fallback glyph. Failures
 * record into the shared cache, so the next render of any surface for that
 * origin shows the next tier.
 */
export function BrowserFavicon(props: {
  url: string | null;
  faviconRef?: string | null | undefined;
  size?: number;
}) {
  const size = props.size ?? 12;
  const ref = props.faviconRef ?? null;
  const resolution = useFaviconResolution(props.url, ref);
  const box = {
    width: size,
    height: size,
    flexShrink: 0,
    borderRadius: 3,
  } as const;
  if (resolution.kind === "glyph")
    return (
      <span
        aria-hidden="true"
        style={{
          ...box,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: Math.max(8, size - 3),
          lineHeight: 1,
          color: muted,
        }}
      >
        {faviconFallbackGlyph(props.url)}
      </span>
    );
  return (
    <img
      src={resolution.src}
      alt=""
      aria-hidden="true"
      draggable={false}
      width={size}
      height={size}
      style={{ ...box, objectFit: "contain" }}
      onError={() => faviconImageFailed(props.url ?? "", resolution)}
    />
  );
}
