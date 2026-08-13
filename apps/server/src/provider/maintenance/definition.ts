// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import type { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export type InstallationDetection<Evidence> =
  | { readonly _tag: "Matched"; readonly evidence: Evidence }
  | { readonly _tag: "NotMatched" }
  | { readonly _tag: "Undetermined"; readonly reason: string };

export interface MaintenanceProbeResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface InstallationContext {
  readonly provider: ProviderDriverKind;
  readonly packageName: string;
  readonly binaryPath: string;
  readonly isBareCommand: boolean;
  readonly resolvedCommandPath: string | null;
  readonly realCommandPath: string | null;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly readTextFile: (path: string) => Effect.Effect<string | null>;
  readonly realPath: (path: string) => Effect.Effect<string>;
  readonly resolveCommand: (command: string) => Effect.Effect<string | null>;
  readonly run: (
    executable: string,
    args: ReadonlyArray<string>,
    environment?: NodeJS.ProcessEnv,
  ) => Effect.Effect<MaintenanceProbeResult | null>;
}

export interface UpdateCommand {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly displayCommand: string;
}

export interface ResolvedInstallation {
  readonly identityKey: string;
  readonly lockKey: string;
  readonly label: string;
  readonly ownershipVerified: boolean;
  readonly packageName: string | null;
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
  readonly update: UpdateCommand | null;
  readonly instructionsUrl: string | null;
}

export interface InstallationDefinition<Evidence> {
  readonly id: string;
  readonly detect: (context: InstallationContext) => Effect.Effect<InstallationDetection<Evidence>>;
  readonly resolve: (
    evidence: Evidence,
    context: InstallationContext,
  ) => Effect.Effect<ResolvedInstallation>;
}

export interface AnyInstallationDefinition {
  readonly id: string;
  readonly detectAndResolve: (
    context: InstallationContext,
  ) => Effect.Effect<
    | { readonly _tag: "Matched"; readonly installation: ResolvedInstallation }
    | { readonly _tag: "NotMatched" }
    | { readonly _tag: "Undetermined"; readonly reason: string }
  >;
}

export function defineInstallation<Evidence>(
  definition: InstallationDefinition<Evidence>,
): AnyInstallationDefinition {
  return {
    id: definition.id,
    detectAndResolve: Effect.fn(`detectAndResolve:${definition.id}`)(function* (context) {
      const detection = yield* definition.detect(context);
      switch (detection._tag) {
        case "Matched":
          return {
            _tag: "Matched",
            installation: yield* definition.resolve(detection.evidence, context),
          } as const;
        case "NotMatched":
          return { _tag: "NotMatched" } as const;
        case "Undetermined":
          return detection;
      }
    }),
  };
}

export interface InstallationCatalog {
  readonly installations: ReadonlyArray<AnyInstallationDefinition>;
  readonly fallbacks: ReadonlyArray<AnyInstallationDefinition>;
}

export function installationIdentity(input: Readonly<Record<string, string | null>>): string {
  const canonical = Object.fromEntries(
    Object.entries(input)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value ?? ""]),
  );
  return NodeCrypto.createHash("sha256")
    .update(`t3-provider-maintenance-v1\0${JSON.stringify(canonical)}`, "utf8")
    .digest("hex");
}

export function canonicalPath(path: string, platform: NodeJS.Platform): string {
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const normalized = pathApi.normalize(pathApi.resolve(path));
  return platform === "win32" ? normalized.replaceAll("\\", "/").toLowerCase() : normalized;
}

export function matched<Evidence>(evidence: Evidence): InstallationDetection<Evidence> {
  return { _tag: "Matched", evidence };
}

export const notMatched: InstallationDetection<never> = { _tag: "NotMatched" };

export function undetermined(reason: string): InstallationDetection<never> {
  return { _tag: "Undetermined", reason };
}
