// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import type { AssetConfig } from "../../shared/types.ts";
import type {
  Logger,
  ParsedHeaders,
  ParsedRedirects,
} from "../../shared/configuration/types.ts";
export declare function constructRedirects({
  redirects,
  redirectsFile,
  logger,
}: {
  redirects?: ParsedRedirects;
  redirectsFile?: string;
  logger: Logger;
}): Pick<AssetConfig, "redirects">;
export declare function constructHeaders({
  headers,
  headersFile,
  logger,
}: {
  headers?: ParsedHeaders;
  headersFile?: string;
  logger: Logger;
}): Pick<AssetConfig, "headers">;
//# sourceMappingURL=constructConfiguration.d.ts.map
