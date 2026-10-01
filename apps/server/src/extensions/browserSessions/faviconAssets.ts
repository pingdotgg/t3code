/**
 * Bounded favicon assets behind `t3.browser/sessions` `faviconRef`.
 * The owner host's fenced page report carries the
 * captured favicon; the sessions projection stores it here and ships only a
 * content-addressed ref, so favicon bytes never ride the session stream.
 *
 * Policy: in-memory, per project. An asset is a `data:image/*;base64` URL of
 * at most `BROWSER_ENGINE_FAVICON_MAX_LENGTH` chars; each project keeps its
 * `perProject` most recently used assets and the store keeps `total` across
 * projects (least recently used evicts first). A ref resolves only inside
 * the project that captured it. Nothing persists: after a server restart the
 * next engine report re-captures, and a stale ref reads as not-found.
 */
import { BROWSER_ENGINE_FAVICON_MAX_LENGTH } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";

/** Native parity: `BROWSER_FAVICON_MAX_ENTRIES` in the native favicon store. */
const FAVICON_ASSETS_PER_PROJECT = 40;
/** Worst case ~3.2 MiB of data URLs. */
const FAVICON_ASSETS_TOTAL = 400;

const FAVICON_DATA_URL =
  /^data:image\/(?:png|x-icon|vnd\.microsoft\.icon|gif|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export interface BrowserFaviconAssets {
  /** Stores (or refreshes) an asset and returns its ref; null when the bytes are refused. */
  readonly capture: (projectId: string, dataUrl: string) => string | null;
  readonly read: (projectId: string, ref: string) => string | null;
}

export function makeBrowserFaviconAssets(
  limits: { readonly perProject: number; readonly total: number } = {
    perProject: FAVICON_ASSETS_PER_PROJECT,
    total: FAVICON_ASSETS_TOTAL,
  },
): BrowserFaviconAssets {
  // Map insertion order is the LRU order; a touch re-inserts at the end.
  const assets = new Map<string, { readonly projectId: string; readonly dataUrl: string }>();
  const counts = new Map<string, number>();
  const keyOf = (projectId: string, ref: string) => `${projectId}\n${ref}`;

  const evict = (key: string) => {
    const entry = assets.get(key);
    if (!entry) return;
    assets.delete(key);
    const count = (counts.get(entry.projectId) ?? 1) - 1;
    if (count === 0) counts.delete(entry.projectId);
    else counts.set(entry.projectId, count);
  };

  const touch = (key: string) => {
    const entry = assets.get(key);
    if (!entry) return null;
    assets.delete(key);
    assets.set(key, entry);
    return entry.dataUrl;
  };

  return {
    capture: (projectId, dataUrl) => {
      if (dataUrl.length > BROWSER_ENGINE_FAVICON_MAX_LENGTH || !FAVICON_DATA_URL.test(dataUrl))
        return null;
      const ref = NodeCrypto.createHash("sha256").update(dataUrl).digest("base64url").slice(0, 32);
      const key = keyOf(projectId, ref);
      if (touch(key) !== null) return ref;
      assets.set(key, { projectId, dataUrl });
      counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
      if ((counts.get(projectId) ?? 0) > limits.perProject) {
        for (const [candidate, entry] of assets) {
          if (entry.projectId === projectId) {
            evict(candidate);
            break;
          }
        }
      }
      if (assets.size > limits.total) {
        const oldest = assets.keys().next();
        if (!oldest.done) evict(oldest.value);
      }
      return ref;
    },
    read: (projectId, ref) => touch(keyOf(projectId, ref)),
  };
}
