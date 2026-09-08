import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";

import type * as VcsProcess from "../vcs/VcsProcess.ts";

export const MINIMUM_VERSION = "0.22.3";

export type VersionCompatibility =
  | { readonly status: "available"; readonly version: string }
  | { readonly status: "incompatible"; readonly version: string | null; readonly detail: string };

export function versionCompatibilityFromOutput(output: string): VersionCompatibility {
  const version = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u.exec(output)?.[1];
  if (!version || !parseSemver(version)) {
    return {
      status: "incompatible",
      version: null,
      detail: `GitButler did not report a supported semantic version. Version ${MINIMUM_VERSION} or newer is required.`,
    };
  }
  if (compareSemverVersions(version, MINIMUM_VERSION) < 0) {
    return {
      status: "incompatible",
      version,
      detail: `GitButler ${MINIMUM_VERSION} or newer is required.`,
    };
  }
  return { status: "available", version };
}

export const readVersionOutput = Effect.fn("GitButlerCli.readVersionOutput")(function* (
  processRunner: VcsProcess.VcsProcess["Service"],
  cwd: string,
  operation: string,
) {
  const result = yield* processRunner.run({
    operation,
    command: "but",
    args: ["--version"],
    cwd,
    timeoutMs: 5_000,
    maxOutputBytes: 8_000,
    appendTruncationMarker: true,
  });
  return `${result.stdout}\n${result.stderr}`;
});
