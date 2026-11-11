import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useId, useState } from "react";
import {
  resolveOfficialAcpRegistryIconUrl,
  officialAcpRegistryIconUrlForAgentId,
} from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { ACPRegistryIcon } from "../Icons";

const ACP_REGISTRY_ICON_CACHE = "t3-acp-registry-icons-v1";
const MAX_ICON_BYTES = 512 * 1_024;
const inFlightIcons = new Map<string, Promise<Blob>>();

export { officialAcpRegistryIconUrlForAgentId, resolveOfficialAcpRegistryIconUrl };

async function checkedIconBlob(response: Response): Promise<Blob> {
  if (!response.ok || response.redirected) throw new Error("ACP registry icon request failed.");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
  if (!contentType.startsWith("image/")) throw new Error("ACP registry icon was not an image.");
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_ICON_BYTES) {
    throw new Error("ACP registry icon was too large.");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_ICON_BYTES) throw new Error("ACP registry icon was too large.");
  return new Blob([bytes], { type: contentType });
}

export function loadCachedAcpRegistryIcon(iconUrl: string): Promise<Blob> {
  if (resolveOfficialAcpRegistryIconUrl(iconUrl) !== iconUrl) {
    return Promise.reject(new Error("ACP registry icon URL was not allowed."));
  }
  const pending = inFlightIcons.get(iconUrl);
  if (pending) return pending;
  const load = (async () => {
    let cache: Cache | null = null;
    if (typeof caches !== "undefined") {
      try {
        cache = await caches.open(ACP_REGISTRY_ICON_CACHE);
      } catch {
        // Privacy modes may expose CacheStorage but reject access; icons still load from the allowlisted CDN.
      }
    }
    if (cache !== null) {
      try {
        const cached = await cache.match(iconUrl);
        if (cached) return await checkedIconBlob(cached);
      } catch {}
    }

    const response = await fetch(iconUrl, {
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    const clone = response.clone();
    const blob = await checkedIconBlob(response);
    await cache?.put(iconUrl, clone).catch(() => undefined);
    return blob;
  })();
  inFlightIcons.set(iconUrl, load);
  void load.then(
    () => inFlightIcons.delete(iconUrl),
    () => inFlightIcons.delete(iconUrl),
  );
  return load;
}

// Falls back to the raw allowlisted CDN URL when the validating fetch fails: the
// CDN serves no CORS headers, so the fetch is often blocked cross-origin while
// native <img> loading still works. The object URL is shared per agent and
// revoked when the last icon unmounts.
const acpRegistryIconSourceAtom = Atom.family((iconUrl: string) =>
  Atom.make((get) => {
    let disposed = false;
    let objectUrl: string | null = null;
    get.addFinalizer(() => {
      disposed = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    });
    return Effect.promise(() =>
      loadCachedAcpRegistryIcon(iconUrl).then(
        (blob) => {
          if (disposed) return iconUrl;
          objectUrl = URL.createObjectURL(blob);
          return objectUrl;
        },
        () => iconUrl,
      ),
    );
  }).pipe(Atom.withLabel(`acp-registry-icon:${iconUrl}`)),
);

const NO_ICON_SOURCE_ATOM = Atom.make(AsyncResult.initial<string>());

export function AcpRegistryAgentIcon({
  icon,
  className,
  fallbackClassName,
}: {
  readonly icon: string | null;
  readonly className?: string;
  readonly fallbackClassName?: string;
}) {
  const colorFilterId = useId();
  const iconUrl = resolveOfficialAcpRegistryIconUrl(icon);
  // Render only after the load pipeline resolves, so the fallback icon does
  // not flash a broken image.
  const source = AsyncResult.getOrElse(
    useAtomValue(iconUrl === null ? NO_ICON_SOURCE_ATOM : acpRegistryIconSourceAtom(iconUrl)),
    () => null,
  );
  const [image, setImage] = useState<{
    readonly source: string;
    readonly status: "loaded" | "failed";
  } | null>(null);
  const status = source !== null && image?.source === source ? image.status : "loading";

  return (
    <span
      aria-hidden
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground",
        className,
      )}
    >
      {/* Recolor alpha because external images cannot inherit currentColor; local SVG filters work despite
       * CDN mask CORS restrictions. */}
      <svg aria-hidden className="pointer-events-none absolute size-0" focusable="false">
        <defs>
          <filter id={colorFilterId} colorInterpolationFilters="sRGB">
            <feFlood floodColor="currentColor" />
            <feComposite in2="SourceAlpha" operator="in" />
          </filter>
        </defs>
      </svg>
      {status !== "loaded" ? (
        <ACPRegistryIcon
          className={cn("size-4", fallbackClassName)}
          data-slot="acp-icon-fallback"
        />
      ) : null}
      {source !== null && status !== "failed" ? (
        <img
          alt=""
          className={cn(
            "size-full object-contain",
            status !== "loaded" && "invisible absolute inset-0",
          )}
          style={{ filter: `url(#${colorFilterId})` }}
          decoding="async"
          referrerPolicy="no-referrer"
          src={source}
          onError={() => setImage({ source, status: "failed" })}
          onLoad={() => setImage({ source, status: "loaded" })}
        />
      ) : null}
    </span>
  );
}
