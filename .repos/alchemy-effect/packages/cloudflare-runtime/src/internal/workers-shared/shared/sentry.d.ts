// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { Toucan } from "toucan-js";
import type { ColoMetadata } from "./types.ts";
export declare function setupSentry(
  request: Request,
  context: ExecutionContext | undefined,
  dsn: string,
  clientId: string,
  clientSecret: string,
  coloMetadata?: ColoMetadata,
  versionMetadata?: WorkerVersionMetadata,
  accountId?: number,
  scriptId?: number,
): Toucan | undefined;
//# sourceMappingURL=sentry.d.ts.map
