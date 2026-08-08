#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off - CI bootstrap intentionally has no Effect runtime or installed dependencies.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  decideReleaseAcrossChannels,
  manifestStagingPercentage,
  prepareReleaseArtifacts,
  readManifest,
  readReleaseConfig,
  verifyPreparedArtifacts,
  type ReleaseAction,
} from "./release-core.ts";

interface ParsedArguments {
  readonly command: string;
  readonly values: ReadonlyMap<string, string>;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const [command, ...rest] = argv;
  if (!command) throw new Error("A command is required.");
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid argument sequence near '${key ?? "<end>"}'.`);
    }
    values.set(key.slice(2), value);
  }
  return { command, values };
}

function valueOrDefault(
  values: ReadonlyMap<string, string>,
  key: string,
  fallback: string,
): string {
  return values.get(key) ?? fallback;
}

function requiredValue(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`--${key} is required.`);
  return value;
}

function parseAction(value: string): ReleaseAction {
  if (value === "dry-run" || value === "publish" || value === "promote" || value === "recovery") {
    return value;
  }
  throw new Error(`Invalid release action '${value}'.`);
}

function parsePercentage(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be an integer.`);
  const parsed = Number(value);
  if (parsed < 1 || parsed > 100) throw new Error(`${label} must be between 1 and 100.`);
  return parsed;
}

async function writeGitHubOutputs(
  outputs: Readonly<Record<string, string | number | boolean>>,
): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    for (const [key, value] of Object.entries(outputs)) console.log(`${key}=${String(value)}`);
    return;
  }
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value)}`);
  await NodeFSP.appendFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

async function fetchText(url: string): Promise<string> {
  const target = new URL(url);
  target.searchParams.set("release_preflight", `${Date.now()}`);
  const response = await fetch(target, {
    headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}.`);
  }
  return response.text();
}

async function run(): Promise<void> {
  const { command, values } = parseArguments(process.argv.slice(2));
  const configPath = valueOrDefault(values, "config", "distributions/2code/release.json");
  const config = await readReleaseConfig(configPath);

  if (command === "validate-config") {
    console.log(`Valid 2code release config: ${config.version} (${config.distribution}).`);
    return;
  }

  if (command === "preflight") {
    const action = parseAction(valueOrDefault(values, "action", "publish"));
    const manifestUrl = `${config.feedUrl}/${config.manifestName}`;
    const betaManifestUrl = `${config.feedUrl}/${config.betaManifestName}`;
    const liveRaw = values.has("live-manifest")
      ? await NodeFSP.readFile(requiredValue(values, "live-manifest"), "utf8")
      : await fetchText(manifestUrl);
    const liveBetaRaw = values.has("live-beta-manifest")
      ? await NodeFSP.readFile(requiredValue(values, "live-beta-manifest"), "utf8")
      : values.has("live-manifest")
        ? liveRaw
        : await fetchText(betaManifestUrl);
    const liveManifest = readManifest(liveRaw, manifestUrl);
    const liveBetaManifest = readManifest(liveBetaRaw, betaManifestUrl);
    const targetStagingPercentage = parsePercentage(
      values.get("staging-percentage"),
      "Promotion staging percentage",
    );
    const recoveryVersion = values.get("recovery-version");
    const decision = decideReleaseAcrossChannels({
      action,
      desiredVersion: config.version,
      latestVersion: liveManifest.version,
      betaVersion: liveBetaManifest.version,
      latestStagingPercentage: manifestStagingPercentage(liveManifest),
      betaStagingPercentage: manifestStagingPercentage(liveBetaManifest),
      channelsHaveIdenticalManifest: liveRaw === liveBetaRaw,
      ...(targetStagingPercentage === undefined ? {} : { targetStagingPercentage }),
      ...(recoveryVersion === undefined || recoveryVersion === "" ? {} : { recoveryVersion }),
      finalizeIfLive: values.get("finalize-if-live") === "true",
    });
    console.log(decision.reason);
    await writeGitHubOutputs({
      desired_version: config.version,
      live_version: liveManifest.version,
      live_beta_version: liveBetaManifest.version,
      decision: decision.decision,
      should_build: decision.shouldBuild,
      should_publish: decision.shouldPublish,
      tag: `${config.githubTagPrefix}${config.version}`,
      staging_percentage: targetStagingPercentage ?? config.stagingPercentage,
      recovery_version: recoveryVersion ?? "",
    });
    return;
  }

  if (command === "prepare") {
    const artifactDirectory = NodePath.resolve(requiredValue(values, "artifact-dir"));
    const plan = await prepareReleaseArtifacts({
      config,
      artifactDirectory,
      sourceCommit: requiredValue(values, "source-commit"),
    });
    console.log(
      `Prepared ${plan.version}: ${plan.payloads.length} immutable payloads, rollout ${plan.stagingPercentage}%.`,
    );
    return;
  }

  if (command === "verify") {
    const artifactDirectory = NodePath.resolve(requiredValue(values, "artifact-dir"));
    const plan = await verifyPreparedArtifacts({ config, artifactDirectory });
    console.log(`Verified 2code ${plan.version} manifest and ${plan.payloads.length} payloads.`);
    return;
  }

  throw new Error(`Unknown command '${command}'.`);
}

await run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
