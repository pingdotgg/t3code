// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import type { AssetConfig } from "../types.ts";
import type { ParsedRedirects } from "./types.ts";
export declare function parseRedirects(
  input: string,
  {
    htmlHandling,
    maxStaticRules,
    maxDynamicRules,
    maxLineLength,
  }?: {
    htmlHandling?: AssetConfig["html_handling"];
    maxStaticRules?: number;
    maxDynamicRules?: number;
    maxLineLength?: number;
  },
): ParsedRedirects;
//# sourceMappingURL=parseRedirects.d.ts.map
