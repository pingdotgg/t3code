import { useEffect, useState } from "react";
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

/** Fetches an official icon once, then serves it from persistent browser cache. */
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
        // Some privacy modes expose CacheStorage but reject access. Icons can
        // still load normally from the allowlisted registry CDN.
      }
    }
    if (cache !== null) {
      try {
        const cached = await cache.match(iconUrl);
        if (cached) return await checkedIconBlob(cached);
      } catch {
        // Ignore unreadable or invalid cache entries and repair from network.
      }
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

export function AcpRegistryAgentIcon({
  icon,
  className,
  fallbackClassName,
}: {
  readonly icon: string | null;
  readonly className?: string;
  readonly fallbackClassName?: string;
}) {
  const iconUrl = resolveOfficialAcpRegistryIconUrl(icon);
  const [image, setImage] = useState<{
    readonly iconUrl: string;
    readonly source: string;
    readonly status: "loading" | "loaded" | "failed";
  } | null>(null);
  const currentImage = image?.iconUrl === iconUrl ? image : null;
  // Render only after the load pipeline resolves: the validated blob when the
  // fetch succeeds, or the raw allowlisted CDN URL when it fails (the official
  // CDN serves no CORS headers, so the validating fetch is often blocked in
  // cross-origin browser contexts while native <img> loading still works).
  const source = currentImage?.source ?? null;
  const status = currentImage?.status ?? "loading";

  useEffect(() => {
    if (iconUrl === null) return;
    let active = true;
    let objectUrl: string | null = null;
    void loadCachedAcpRegistryIcon(iconUrl)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setImage({ iconUrl, source: objectUrl, status: "loading" });
      })
      .catch(() => {
        if (!active) return;
        setImage((current) =>
          current?.iconUrl === iconUrl ? current : { iconUrl, source: iconUrl, status: "loading" },
        );
      });
    return () => {
      active = false;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [iconUrl]);

  return (
    <span
      aria-hidden
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground",
        className,
      )}
    >
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
          decoding="async"
          referrerPolicy="no-referrer"
          src={source}
          onError={() => {
            if (iconUrl === null) return;
            setImage((current) =>
              current?.iconUrl === iconUrl && current.source !== source
                ? current
                : { iconUrl, source, status: "failed" },
            );
          }}
          onLoad={() => {
            if (iconUrl !== null) setImage({ iconUrl, source, status: "loaded" });
          }}
        />
      ) : null}
    </span>
  );
}
