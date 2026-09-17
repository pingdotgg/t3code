// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { mockJaegerBinding } from "../../../../shared/tracing.ts";
import {
  flagIsEnabled,
  SEC_FETCH_MODE_NAVIGATE_HEADER_PREFERS_ASSET_SERVING,
} from "../compatibility-flags.ts";
import { CACHE_CONTROL_BROWSER } from "../constants.ts";
import { HEADERS_VERSION } from "../handler.ts";
import { generateRulesMatcher, replacer } from "./rules-engine.ts";
import type { AssetConfig, JaegerTracing } from "../../../../shared/types.ts";
import type { AssetIntentWithResolver } from "../handler.ts";
import type { Env } from "../worker.ts";

/**
 * Returns a Headers object that contains additional headers (to those
 * present in the original request) that the Assets Server Worker
 * should attach to its response.
 *
 */
export function getAssetHeaders(
  { eTag, resolver }: AssetIntentWithResolver,
  contentType: string | undefined,
  cacheStatus: string,
  request: Request,
  configuration: Required<AssetConfig>,
) {
  const headers = new Headers({
    ETag: `"${eTag}"`,
  });

  if (contentType !== undefined) {
    headers.append("Content-Type", contentType);
  }

  if (isCacheable(request)) {
    headers.append("Cache-Control", CACHE_CONTROL_BROWSER);
  }

  // Attach CF-Cache-Status, this will show to users that we are caching assets
  // and it will also populate the cache fields through the logging pipeline.
  headers.append("CF-Cache-Status", cacheStatus);

  if (
    configuration.debug &&
    resolver === "not-found" &&
    flagIsEnabled(
      configuration,
      SEC_FETCH_MODE_NAVIGATE_HEADER_PREFERS_ASSET_SERVING,
    )
  ) {
    headers.append(
      "X-Mf-Additional-Response-Log",
      "`Sec-Fetch-Mode: navigate` header present - using `not_found_handling` behavior",
    );
  }

  return headers;
}

function isCacheable(request: Request) {
  return !request.headers.has("Authorization") && !request.headers.has("Range");
}

export function attachCustomHeaders(
  request: Request,
  response: Response,
  configuration: Required<AssetConfig>,
  env: Env,
) {
  const jaeger: JaegerTracing = env.JAEGER ?? mockJaegerBinding();
  return jaeger.enterSpan("add_headers", (span) => {
    // Iterate through rules and find rules that match the path
    const headersMatcher = generateRulesMatcher(
      configuration.headers?.version === HEADERS_VERSION
        ? configuration.headers.rules
        : {},
      ({ set = {}, unset = [] }, replacements) => {
        const replacedSet: Record<string, string> = {};
        Object.entries(set).forEach(([key, value]) => {
          replacedSet[key] = replacer(value, replacements);
        });
        return {
          set: replacedSet,
          unset,
        };
      },
    );
    const matches = headersMatcher({ request });

    // This keeps track of every header that we've set from _headers
    // because we want to combine user declared headers but overwrite
    // existing and extra ones
    const setMap = new Set();
    // Apply every matched rule in order
    matches.forEach(({ set = {}, unset = [] }) => {
      unset.forEach((key) => {
        response.headers.delete(key);
        span.addLogs({ remove_header: key });
      });
      Object.entries(set).forEach(([key, value]) => {
        if (setMap.has(key.toLowerCase())) {
          response.headers.append(key, value);
          span.addLogs({ append_header: key });
        } else {
          response.headers.set(key, value);
          setMap.add(key.toLowerCase());
          span.addLogs({ add_header: key });
        }
      });
    });

    return response;
  });
}
