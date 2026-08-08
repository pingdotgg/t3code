#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - release notarization invokes Apple's macOS tooling through the official Electron adapter.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { notarize, type NotarizeOptions } from "@electron/notarize";

import {
  expectedArtifactNames,
  readReleaseConfig,
  type TwoCodeReleaseConfig,
} from "./release-core.ts";

interface NotarizationEnvironment {
  readonly APPLE_ID?: string;
  readonly APPLE_APP_SPECIFIC_PASSWORD?: string;
  readonly APPLE_TEAM_ID?: string;
}

function requireEnvironmentVariable(
  environment: NotarizationEnvironment,
  name: keyof NotarizationEnvironment,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required notarization credential: ${name}.`);
  return value;
}

export function resolveDmgNotarizationOptions(
  config: TwoCodeReleaseConfig,
  artifactDirectory: string,
  environment: NotarizationEnvironment,
): NotarizeOptions {
  const appleId = requireEnvironmentVariable(environment, "APPLE_ID");
  const appleIdPassword = requireEnvironmentVariable(environment, "APPLE_APP_SPECIFIC_PASSWORD");
  const teamId = requireEnvironmentVariable(environment, "APPLE_TEAM_ID");
  if (teamId !== config.teamId) {
    throw new Error("APPLE_TEAM_ID does not match the frozen 2code identity.");
  }
  const [, dmgName] = expectedArtifactNames(config);
  return {
    appPath: NodePath.resolve(artifactDirectory, dmgName),
    appleId,
    appleIdPassword,
    teamId,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const artifactIndex = args.indexOf("--artifact-dir");
  const configIndex = args.indexOf("--config");
  const artifactDirectory = artifactIndex >= 0 ? args[artifactIndex + 1] : undefined;
  const configPath = configIndex >= 0 ? args[configIndex + 1] : "distributions/2code/release.json";
  if (!artifactDirectory) throw new Error("--artifact-dir is required.");

  const config = await readReleaseConfig(configPath);
  const options = resolveDmgNotarizationOptions(config, artifactDirectory, process.env);
  await NodeFSP.access(options.appPath);
  await notarize(options);
  console.log(`Notarized and stapled ${NodePath.basename(options.appPath)}.`);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
