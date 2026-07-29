import type { HostApplicationDescriptor } from "@t3tools/contracts";
import { useEffect, useState } from "react";

export const MAC_APPCAST_URL =
  "https://raw.githubusercontent.com/SergeSerb2/SergeCode/main/apps/mac/Support/appcast.xml";

export interface MacAppRelease {
  readonly version: string;
  readonly buildNumber: number;
}

export function parseLatestMacAppRelease(xml: string): MacAppRelease | null {
  const item = /<item\b[^>]*>([\s\S]*?)<\/item>/i.exec(xml)?.[1];
  if (!item) return null;

  const version = /<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/i
    .exec(item)?.[1]
    ?.trim();
  const rawBuild = /<sparkle:version>([^<]+)<\/sparkle:version>/i.exec(item)?.[1]?.trim();
  const buildNumber = rawBuild === undefined ? Number.NaN : Number.parseInt(rawBuild, 10);
  if (!version || !Number.isSafeInteger(buildNumber) || buildNumber < 0) {
    return null;
  }
  return { version, buildNumber };
}

export function hostNeedsMacAppUpdate(
  host: HostApplicationDescriptor,
  latest: MacAppRelease,
): boolean {
  const hostBuild = Number.parseInt(host.buildNumber, 10);
  return Number.isSafeInteger(hostBuild) && hostBuild < latest.buildNumber;
}

const RELEASE_CACHE_TTL_MS = 15 * 60 * 1_000;
let latestReleasePromise: Promise<MacAppRelease | null> | null = null;
let latestReleaseLoadedAt = 0;

async function fetchLatestMacAppRelease(): Promise<MacAppRelease | null> {
  const response = await fetch(MAC_APPCAST_URL, {
    headers: { Accept: "application/xml, text/xml;q=0.9, */*;q=0.1" },
  });
  if (!response.ok) return null;
  return parseLatestMacAppRelease(await response.text());
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
