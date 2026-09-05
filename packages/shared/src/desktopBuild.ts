import type { DesktopAppStageLabel } from "@t3tools/contracts";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import * as Schema from "effect/Schema";

const APP_BASE_NAME = "T3 Code";

/** Identity embedded in a packaged desktop app by the artifact builder. */
export const DesktopPackagedAppIdentity = Schema.Struct({
  appId: TrimmedNonEmptyString,
  packageName: TrimmedNonEmptyString,
  productName: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  distributionName: Schema.NullOr(TrimmedNonEmptyString),
  distributionId: Schema.NullOr(TrimmedNonEmptyString),
});
export type DesktopPackagedAppIdentity = typeof DesktopPackagedAppIdentity.Type;

/** Build metadata read by Electron before desktop runtime layers are created. */
export const DesktopPackageMetadata = Schema.Struct({
  t3codeDesktopIdentity: Schema.optional(DesktopPackagedAppIdentity),
});

function distributionIdFromName(name: string): string {
  const readable = name.toLowerCase().replaceAll(" ", "-").slice(0, 24);
  const digest = Array.from(sha256(new TextEncoder().encode(name)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${readable}-${digest}`;
}

/** Resolve runtime identity, preferring the exact identity embedded by new builds. */
export function resolveDesktopRuntimeIdentity(input: {
  readonly isDevelopment: boolean;
  readonly isPackaged: boolean;
  readonly stageLabel: DesktopAppStageLabel;
  readonly appName?: string;
  readonly packagedIdentity?: DesktopPackagedAppIdentity;
}): DesktopPackagedAppIdentity {
  const officialDisplayName = `${APP_BASE_NAME} (${input.stageLabel})`;
  const runtimeName =
    input.isPackaged && input.appName?.trim() ? input.appName.trim() : officialDisplayName;
  if (input.isPackaged && input.packagedIdentity !== undefined) {
    return input.packagedIdentity;
  }
  if (!input.isPackaged || runtimeName === officialDisplayName) {
    return {
      appId: input.isDevelopment ? "com.t3tools.t3code.dev" : "com.t3tools.t3code",
      packageName: input.isDevelopment ? "t3code-dev" : "t3code",
      productName: runtimeName,
      displayName: runtimeName,
      distributionName: null,
      distributionId: null,
    };
  }

  // Compatibility for packages produced before the embedded identity existed.
  const legacyMatch = /^T3 Code \((.+) (?:Alpha|Nightly)\)$/u.exec(runtimeName);
  const stableMatch = /^T3 Code \((.+)\)$/u.exec(runtimeName);
  const distributionName = legacyMatch?.[1] ?? stableMatch?.[1] ?? runtimeName;
  const distributionId = distributionIdFromName(distributionName);
  const productName = legacyMatch || stableMatch ? `T3 Code (${distributionName})` : runtimeName;
  return {
    appId: `com.t3tools.t3code.${distributionId}`,
    packageName: `t3code-${distributionId}`,
    productName,
    displayName: legacyMatch
      ? runtimeName
      : stableMatch
        ? `T3 Code (${distributionName} ${input.stageLabel})`
        : runtimeName,
    distributionName,
    distributionId,
  };
}
