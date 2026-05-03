import type { DiscoveredLocalServer } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { useEffect, useMemo, useState } from "react";

import { ensureEnvironmentApi } from "~/environmentApi";
import type { EnvironmentId } from "@t3tools/contracts";

export interface PreviewableServer extends DiscoveredLocalServer {
  source: "scanner" | "configured" | "recent";
  /**
   * True when the port scanner currently sees this server listening. A
   * `configured` entry can also be `listening` when the scan enriched it.
   */
  listening: boolean;
}

interface UseDiscoveredLocalServersInput {
  environmentId: EnvironmentId;
  configuredUrls?: ReadonlyArray<string> | undefined;
  recentlySeenUrls?: ReadonlyArray<string> | undefined;
}

/**
 * Subscribe to live localhost port scans, merge in configured /
 * recently-seen URLs, and return a stable sorted list. Retains the scanner
 * while mounted.
 */
export function useDiscoveredLocalServers(
  input: UseDiscoveredLocalServersInput,
): ReadonlyArray<PreviewableServer> {
  const [scannerSnapshot, setScannerSnapshot] = useState<ReadonlyArray<DiscoveredLocalServer>>([]);

  useEffect(() => {
    const api = ensureEnvironmentApi(input.environmentId);
    setScannerSnapshot([]);
    const unsubscribe = api.preview.subscribePorts((next) => {
      setScannerSnapshot(next.servers);
    });
    return unsubscribe;
  }, [input.environmentId]);

  return useMemo(
    () =>
      mergeServers({
        scanner: scannerSnapshot,
        configuredUrls: input.configuredUrls ?? [],
        recentlySeenUrls: input.recentlySeenUrls ?? [],
      }),
    [scannerSnapshot, input.configuredUrls, input.recentlySeenUrls],
  );
}

export function mergeServers(input: {
  scanner: ReadonlyArray<DiscoveredLocalServer>;
  configuredUrls: ReadonlyArray<string>;
  recentlySeenUrls: ReadonlyArray<string>;
}): ReadonlyArray<PreviewableServer> {
  const seen = new Map<string, PreviewableServer>();

  for (const url of input.configuredUrls) {
    const parsed = parseLocalUrl(url);
    if (!parsed) continue;
    const key = canonicalKey(parsed.host, parsed.port);
    if (seen.has(key)) continue;
    seen.set(key, {
      host: parsed.host,
      port: parsed.port,
      url: parsed.url,
      processName: null,
      pid: null,
      source: "configured",
      listening: false,
    });
  }

  for (const server of input.scanner) {
    const key = canonicalKey(server.host, server.port);
    const existing = seen.get(key);
    if (existing) {
      // Enrich a configured entry with live process metadata; flip
      // `listening` so it pulses green like a scanner-discovered entry.
      seen.set(key, {
        ...existing,
        processName: server.processName ?? existing.processName,
        pid: server.pid ?? existing.pid,
        listening: true,
      });
      continue;
    }
    seen.set(key, { ...server, source: "scanner", listening: true });
  }

  for (const url of input.recentlySeenUrls) {
    const parsed = parseLocalUrl(url);
    if (!parsed) continue;
    const key = canonicalKey(parsed.host, parsed.port);
    if (seen.has(key)) continue;
    seen.set(key, {
      host: parsed.host,
      port: parsed.port,
      url: parsed.url,
      processName: null,
      pid: null,
      source: "recent",
      listening: false,
    });
  }

  return Array.from(seen.values()).toSorted((a, b) => {
    const sourceOrder: Record<PreviewableServer["source"], number> = {
      configured: 0,
      scanner: 1,
      recent: 2,
    };
    if (sourceOrder[a.source] !== sourceOrder[b.source]) {
      return sourceOrder[a.source] - sourceOrder[b.source];
    }
    return a.port - b.port;
  });
}

function canonicalKey(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`;
}

function parseLocalUrl(raw: string): { host: string; port: number; url: string } | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!isLoopbackHost(parsed.hostname)) return null;
    const port = parsed.port
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === "http:"
        ? 80
        : 443;
    if (!Number.isFinite(port) || port <= 0) return null;
    return { host: parsed.hostname, port, url: parsed.href };
  } catch {
    return null;
  }
}
