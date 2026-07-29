import type { HostApplicationDescriptor } from "@t3tools/contracts";
import { useEffect, useState } from "react";

export const MAC_APPCAST_URL =
  "https://raw.githubusercontent.com/SergeSerb2/SergeCode/main/apps/mac/Support/appcast.xml";

export interface MacAppRelease {
  readonly version: string;
  readonly buildNumber: number;
}

export function parseLatestMacAppRelease(xml: string): MacAppRelease | null {
  let latest: MacAppRelease | null = null;
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item = match[1];
    const version = /<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/i
      .exec(item)?.[1]
      ?.trim();
    const rawBuild = /<sparkle:version>([^<]+)<\/sparkle:version>/i.exec(item)?.[1]?.trim();
    const buildNumber =
      rawBuild === undefined || !/^\d+$/.test(rawBuild)
        ? Number.NaN
        : Number.parseInt(rawBuild, 10);
    if (!version || !Number.isSafeInteger(buildNumber) || buildNumber < 0) {
      continue;
    }
    if (latest === null || buildNumber > latest.buildNumber) {
      latest = { version, buildNumber };
    }
  }
  return latest;
}

export function hostNeedsMacAppUpdate(
  host: HostApplicationDescriptor,
  latest: MacAppRelease,
): boolean {
  if (host.updateCapability !== "sparkle") return false;
  const hostBuild = /^\d+$/.test(host.buildNumber)
    ? Number.parseInt(host.buildNumber, 10)
    : Number.NaN;
  return Number.isSafeInteger(hostBuild) && hostBuild < latest.buildNumber;
}

const RELEASE_CACHE_TTL_MS = 15 * 60 * 1_000;
let latestReleasePromise: Promise<MacAppRelease | null> | null = null;
let latestReleaseLoadedAt = 0;

async function fetchLatestMacAppRelease(): Promise<MacAppRelease | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(MAC_APPCAST_URL, {
      headers: { Accept: "application/xml, text/xml;q=0.9, */*;q=0.1" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseLatestMacAppRelease(await response.text());
  } finally {
    clearTimeout(timeout);
  }
}

export function loadLatestMacAppRelease(): Promise<MacAppRelease | null> {
  if (latestReleasePromise === null || Date.now() - latestReleaseLoadedAt >= RELEASE_CACHE_TTL_MS) {
    latestReleaseLoadedAt = Date.now();
    latestReleasePromise = fetchLatestMacAppRelease().catch(() => {
      latestReleaseLoadedAt = 0;
      return null;
    });
  }
  return latestReleasePromise;
}

export function useLatestMacAppRelease(): MacAppRelease | null {
  const [release, setRelease] = useState<MacAppRelease | null>(null);
  useEffect(() => {
    let active = true;
    void loadLatestMacAppRelease().then((value) => {
      if (active) setRelease(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return release;
}
