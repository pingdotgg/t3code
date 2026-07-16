import {
  MarketplaceEntry,
  PluginManagementError,
  type MarketplaceVersion,
  type PluginCatalogResult,
  type PluginId,
  type PluginSource,
} from "@t3tools/contracts/plugin";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClientResponse } from "effect/unstable/http";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";

import { PluginHttpClientTransportService } from "./capabilities/HttpClientCapability.ts";
import { guardedOutboundHttpGet } from "./guardedOutboundHttpGet.ts";
import { OutboundUrlLookup } from "./OutboundUrlValidator.ts";
import { readHttpResponseBytesCapped } from "./readHttpResponseBytesCapped.ts";

const MARKETPLACE_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const MARKETPLACE_FETCH_TIMEOUT_MS = 30_000;
const CATALOG_CACHE_TTL_MS = 30_000;
const OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export const MarketplaceIndex = Schema.Struct({
  plugins: Schema.Array(MarketplaceEntry),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type MarketplaceIndex = typeof MarketplaceIndex.Type;

const decodeMarketplaceIndexJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MarketplaceIndex),
);
const isPluginManagementError = Schema.is(PluginManagementError);

const managementError = (code: PluginManagementError["code"], message: string, data?: unknown) =>
  new PluginManagementError({
    code,
    message,
    ...(data === undefined ? {} : { data }),
  });

export function sourceIdForUrl(url: string): string {
  return `src-${NodeCrypto.createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
}

function canonicalHttpsUrl(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:") return null;
    url.hash = "";
    // Strip any embedded credentials: this URL is persisted in the lockfile and
    // echoed back via listSources / error payloads, so `https://user:pw@host`
    // would leak the secret. Credentialed marketplace URLs are not supported.
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * True when a stored source URL refers to the same marketplace as
 * `canonicalUrl` (an already-normalized value from {@link resolveMarketplaceUrl}).
 * Stored URLs are normally already canonical, but a row persisted before
 * credentials were stripped may still embed them; compare on the canonical
 * (credential-stripped) form so such a row still dedupes against a freshly
 * normalized add instead of registering the same marketplace twice.
 */
export function isSameMarketplaceSource(storedUrl: string, canonicalUrl: string): boolean {
  if (storedUrl === canonicalUrl) return true;
  const canonicalStored = canonicalHttpsUrl(storedUrl);
  return canonicalStored !== null && canonicalStored === canonicalUrl;
}

export function resolveMarketplaceUrl(input: string): string {
  const trimmed = input.trim();
  if (OWNER_REPO_PATTERN.test(trimmed)) {
    return `https://raw.githubusercontent.com/${trimmed}/HEAD/marketplace.json`;
  }

  const https = canonicalHttpsUrl(trimmed);
  if (https !== null) return https;

  const url = new URL(trimmed);
  if (url.protocol === "file:" && process.env.T3_PLUGIN_DEV === "1") {
    return url.toString();
  }
  throw managementError(
    "invalid-source",
    "Plugin sources must be HTTPS URLs or owner/repo shorthand.",
    { url: input },
  );
}

export function resolveTarballUrl(input: {
  readonly tarball: string;
  readonly marketplaceUrl: string;
}): string {
  const url = new URL(input.tarball, input.marketplaceUrl);
  if (url.protocol === "https:") {
    url.hash = "";
    // Strip embedded credentials, symmetric with canonicalHttpsUrl: this URL is
    // logged and surfaced in error payloads, so `https://user:pw@host/x.tgz` would
    // leak the secret. Credentialed tarball URLs are not supported.
    url.username = "";
    url.password = "";
    return url.toString();
  }
  if (url.protocol === "file:" && process.env.T3_PLUGIN_DEV === "1") {
    return url.toString();
  }
  throw managementError("invalid-source", "Plugin tarballs must resolve to HTTPS URLs.", {
    tarball: input.tarball,
  });
}

export class PluginMarketplace extends Context.Service<
  PluginMarketplace,
  {
    readonly normalizeSourceUrl: (url: string) => Effect.Effect<string, PluginManagementError>;
    readonly fetchSource: (
      source: PluginSource,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<MarketplaceIndex, PluginManagementError>;
    readonly catalog: (
      sources: ReadonlyArray<PluginSource>,
      sourceId?: string,
    ) => Effect.Effect<PluginCatalogResult, PluginManagementError>;
    readonly findVersion: (input: {
      readonly source: PluginSource;
      readonly pluginId: PluginId;
      readonly version: string;
    }) => Effect.Effect<
      {
        readonly entry: MarketplaceEntry;
        readonly version: MarketplaceVersion;
        readonly marketplaceUrl: string;
        readonly tarballUrl: string;
      },
      PluginManagementError
    >;
  }
>()("t3/plugins/PluginMarketplace") {}

interface CachedIndex {
  readonly expiresAtMs: number;
  readonly index: MarketplaceIndex;
}

export const make = Effect.fn("PluginMarketplace.make")(function* () {
  const clock = yield* Clock.Clock;
  const fs = yield* FileSystem.FileSystem;
  const lookup = yield* OutboundUrlLookup;
  const transport = yield* PluginHttpClientTransportService;
  const cache = yield* Ref.make(new Map<string, CachedIndex>());

  const normalizeSourceUrl = (url: string) =>
    Effect.try({
      try: () => resolveMarketplaceUrl(url),
      catch: (cause) =>
        isPluginManagementError(cause)
          ? cause
          : managementError("invalid-source", "Plugin source URL is invalid.", { cause }),
    });

  const readFileUrl = (url: string) =>
    fs.readFile(NodeURL.fileURLToPath(url)).pipe(
      Effect.mapError((cause) =>
        managementError("catalog-fetch-failed", "Failed to read plugin marketplace file.", {
          url,
          cause,
        }),
      ),
    );

  // Marketplace URLs are untrusted input: fetch them through the SSRF guard
  // (per-hop URL validation + DNS-pinned transport, redirects re-validated)
  // instead of the raw host HttpClient, which would happily follow a 30x into
  // loopback/private/metadata addresses.
  const readHttpUrl = (url: string) =>
    guardedOutboundHttpGet({
      url,
      lookup,
      transport,
      headers: { accept: "application/json" },
      timeoutMs: MARKETPLACE_FETCH_TIMEOUT_MS,
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "OutboundUrlError"
          ? managementError(
              "catalog-fetch-failed",
              `Plugin marketplace URL is not allowed: ${cause.reason}.`,
              { url },
            )
          : managementError("catalog-fetch-failed", "Failed to fetch plugin marketplace.", {
              url,
              cause,
            }),
      ),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError((cause) =>
        isPluginManagementError(cause)
          ? cause
          : managementError(
              "catalog-fetch-failed",
              "Plugin marketplace returned a non-OK response.",
              {
                url,
                cause,
              },
            ),
      ),
      Effect.flatMap((response) =>
        readHttpResponseBytesCapped({
          response,
          maxBytes: MARKETPLACE_RESPONSE_MAX_BYTES,
          tooLarge: (actual) =>
            managementError("catalog-fetch-failed", "Plugin marketplace is too large.", {
              url,
              limit: MARKETPLACE_RESPONSE_MAX_BYTES,
              actual,
            }),
          readFailed: (cause) =>
            managementError("catalog-fetch-failed", "Failed to read plugin marketplace body.", {
              url,
              cause,
            }),
        }),
      ),
      // Hard wall-clock deadline around the whole fetch + body read. The
      // transport `timeoutMs` only bounds SOCKET INACTIVITY (it resets on every
      // byte), so a byte-drip endpoint could hold catalog refresh open forever
      // while staying under the byte cap. Same defense HttpClientCapability.ts
      // (~313-364) documents for this attack.
      Effect.timeoutOrElse({
        duration: Duration.millis(MARKETPLACE_FETCH_TIMEOUT_MS),
        orElse: () =>
          managementError(
            "catalog-fetch-failed",
            "Plugin marketplace fetch exceeded the time limit.",
            { url, timeoutMs: MARKETPLACE_FETCH_TIMEOUT_MS },
          ),
      }),
    );

  const readBytes = (url: string) =>
    url.startsWith("file:") ? readFileUrl(url) : readHttpUrl(url);

  const fetchSource: PluginMarketplace["Service"]["fetchSource"] = (source, options) =>
    Effect.gen(function* () {
      const marketplaceUrl = yield* normalizeSourceUrl(source.url);
      const now = yield* clock.currentTimeMillis;
      if (options?.refresh !== true) {
        const cached = (yield* Ref.get(cache)).get(marketplaceUrl);
        if (cached && cached.expiresAtMs > now) return cached.index;
      }

      const bytes = yield* readBytes(marketplaceUrl);
      if (bytes.byteLength > MARKETPLACE_RESPONSE_MAX_BYTES) {
        return yield* managementError("catalog-fetch-failed", "Plugin marketplace is too large.", {
          sourceId: source.id,
          limit: MARKETPLACE_RESPONSE_MAX_BYTES,
          actual: bytes.byteLength,
        });
      }

      const index = yield* decodeMarketplaceIndexJson(new TextDecoder().decode(bytes)).pipe(
        Effect.mapError((cause) =>
          managementError("catalog-fetch-failed", "Plugin marketplace JSON is invalid.", {
            sourceId: source.id,
            cause,
          }),
        ),
      );
      yield* Ref.update(cache, (current) => {
        const next = new Map(current);
        next.set(marketplaceUrl, { index, expiresAtMs: now + CATALOG_CACHE_TTL_MS });
        return next;
      });
      return index;
    });

  const catalog: PluginMarketplace["Service"]["catalog"] = (sources, sourceId) =>
    Effect.gen(function* () {
      const selected =
        sourceId === undefined ? sources : sources.filter((source) => source.id === sourceId);
      if (sourceId !== undefined && selected.length === 0) {
        return yield* managementError("source-not-found", "Plugin source was not found.", {
          sourceId,
        });
      }
      const results = yield* Effect.forEach(
        selected,
        (source) =>
          fetchSource(source).pipe(
            Effect.match({
              onFailure: (error) => ({
                source,
                error,
                index: null,
              }),
              onSuccess: (index) => ({
                source,
                error: null,
                index,
              }),
            }),
          ),
        { concurrency: 4 },
      );
      return {
        entries: results.flatMap((result) =>
          result.index === null ? [] : Array.from(result.index.plugins),
        ),
        errors: results.flatMap((result) =>
          result.error === null
            ? []
            : [
                {
                  sourceId: result.source.id,
                  url: result.source.url,
                  message: result.error.message,
                },
              ],
        ),
      };
    });

  const findVersion: PluginMarketplace["Service"]["findVersion"] = (input) =>
    Effect.gen(function* () {
      const marketplaceUrl = yield* normalizeSourceUrl(input.source.url);
      const index = yield* fetchSource(input.source, { refresh: true });
      const entry = index.plugins.find((candidate) => candidate.id === input.pluginId);
      if (entry === undefined) {
        return yield* managementError("plugin-not-found", "Plugin was not found in source.", {
          pluginId: input.pluginId,
          sourceId: input.source.id,
        });
      }
      const version = entry.versions.find((candidate) => candidate.version === input.version);
      if (version === undefined) {
        return yield* managementError("version-not-found", "Plugin version was not found.", {
          pluginId: input.pluginId,
          version: input.version,
          sourceId: input.source.id,
        });
      }
      // resolveTarballUrl throws synchronously (PluginManagementError for a
      // non-HTTPS URL, or a TypeError for a malformed one). Wrap it so a bad
      // marketplace entry surfaces as a typed failure instead of a defect.
      const tarballUrl = yield* Effect.try({
        try: () => resolveTarballUrl({ tarball: version.tarball, marketplaceUrl }),
        catch: (cause) =>
          isPluginManagementError(cause)
            ? cause
            : managementError("invalid-source", "Plugin tarball URL is invalid.", { cause }),
      });
      return {
        entry,
        version,
        marketplaceUrl,
        tarballUrl,
      };
    });

  return PluginMarketplace.of({
    normalizeSourceUrl,
    fetchSource,
    catalog,
    findVersion,
  });
});

export const layer = Layer.effect(PluginMarketplace, make());
