// @effect-diagnostics nodeBuiltinImport:off - Release artifact preparation is a host-side filesystem tool.

import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  parseUpdateManifest,
  serializeUpdateManifest,
  type UpdateManifest,
} from "../../lib/update-manifest.ts";

export const RELEASE_CONFIG_PATH = "distributions/2code/release.json";
export const RELEASE_PLAN_NAME = "2code-release-plan.json";

export type ReleaseAction = "dry-run" | "publish" | "promote" | "recovery";

export interface TwoCodeReleaseConfig {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly distribution: "2code-production";
  readonly releaseBranch: "main-2code";
  readonly githubRepository: string;
  readonly githubTagPrefix: "2code-v";
  readonly appId: "dev.hafencity.dev.agents";
  readonly productName: "2code";
  readonly executableName: "2code";
  readonly architecture: "arm64";
  readonly teamId: string;
  readonly feedUrl: string;
  readonly r2Bucket: string;
  readonly r2Prefix: string;
  readonly manifestName: "latest-mac.yml";
  readonly betaManifestName: "beta-mac.yml";
  readonly updaterCacheDirName: "2code-updater";
  readonly protocolSchemes: readonly string[];
  readonly stagingPercentage: number;
  readonly minimumLegacyVersion: string;
}

export interface PreparedPayload {
  readonly localName: string;
  readonly remotePath: string;
  readonly sha512: string;
  readonly size: number;
  readonly contentType: string;
}

export interface TwoCodeReleasePlan {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly tag: string;
  readonly sourceCommit: string;
  readonly configSha256: string;
  readonly manifestName: "latest-mac.yml";
  readonly manifestSha512: string;
  readonly stagingPercentage: number;
  readonly payloads: readonly PreparedPayload[];
}

export interface PreflightDecision {
  readonly decision: "skip" | "build" | "resume" | "finalize" | "promote" | "recover";
  readonly shouldBuild: boolean;
  readonly shouldPublish: boolean;
  readonly reason: string;
}

interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`2code release config '${key}' must be a non-empty string.`);
  }
  return value;
}

function requireLiteral<T extends string>(
  record: Record<string, unknown>,
  key: string,
  expected: T,
): T {
  const value = requireString(record, key);
  if (value !== expected) {
    throw new Error(`2code release config '${key}' must be '${expected}', got '${value}'.`);
  }
  return expected;
}

function parseStableSemver(value: string, label: string): Semver {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`${label} must be a stable semantic version (x.y.z), got '${value}'.`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareStableVersions(left: string, right: string): -1 | 0 | 1 {
  const a = parseStableSemver(left, "Left version");
  const b = parseStableSemver(right, "Right version");
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  return 0;
}

function validateSafeObjectPath(value: string, label: string): string {
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.split("/").some((segment) => segment === "." || segment === ".." || segment === "")
  ) {
    throw new Error(`${label} must be a safe relative object path, got '${value}'.`);
  }
  return value;
}

export function parseReleaseConfig(value: unknown): TwoCodeReleaseConfig {
  assertRecord(value, "2code release config");
  if (value.schemaVersion !== 1) {
    throw new Error("2code release config 'schemaVersion' must be 1.");
  }

  const version = requireString(value, "version");
  const minimumLegacyVersion = requireString(value, "minimumLegacyVersion");
  parseStableSemver(version, "2code release version");
  parseStableSemver(minimumLegacyVersion, "Minimum legacy version");
  if (compareStableVersions(version, minimumLegacyVersion) < 0) {
    throw new Error(
      `2code release version ${version} cannot be lower than legacy version ${minimumLegacyVersion}.`,
    );
  }

  const githubRepository = requireString(value, "githubRepository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepository)) {
    throw new Error(`Invalid GitHub repository '${githubRepository}'.`);
  }

  const feedUrl = requireString(value, "feedUrl");
  const parsedFeedUrl = new URL(feedUrl);
  if (parsedFeedUrl.protocol !== "https:" || parsedFeedUrl.search || parsedFeedUrl.hash) {
    throw new Error("2code feedUrl must be an HTTPS URL without query parameters or a fragment.");
  }

  const r2Prefix = validateSafeObjectPath(requireString(value, "r2Prefix"), "r2Prefix");
  if (parsedFeedUrl.pathname.replace(/^\//, "").replace(/\/$/, "") !== r2Prefix) {
    throw new Error(`feedUrl must end with the configured R2 prefix '${r2Prefix}'.`);
  }

  const teamId = requireString(value, "teamId");
  if (!/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error(`Invalid Apple team ID '${teamId}'.`);
  }

  if (!Number.isInteger(value.stagingPercentage)) {
    throw new Error("2code release config 'stagingPercentage' must be an integer.");
  }
  const stagingPercentage = value.stagingPercentage as number;
  if (stagingPercentage < 1 || stagingPercentage > 100) {
    throw new Error("2code stagingPercentage must be between 1 and 100.");
  }

  if (!Array.isArray(value.protocolSchemes)) {
    throw new Error("2code release config 'protocolSchemes' must be an array.");
  }
  const protocolSchemes = value.protocolSchemes.map((scheme) => {
    if (typeof scheme !== "string" || !/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
      throw new Error(`Invalid protocol scheme '${String(scheme)}'.`);
    }
    return scheme;
  });
  for (const requiredScheme of ["twentyfirst-agents"]) {
    if (!protocolSchemes.includes(requiredScheme)) {
      throw new Error(`2code release config must retain protocol scheme '${requiredScheme}'.`);
    }
  }
  if (protocolSchemes.length !== 1) {
    throw new Error(
      "2code must register only the legacy 'twentyfirst-agents' OS protocol so it can coexist with T3 Code.",
    );
  }

  const r2Bucket = requireString(value, "r2Bucket");
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(r2Bucket)) {
    throw new Error(`Invalid R2 bucket '${r2Bucket}'.`);
  }

  return {
    schemaVersion: 1,
    version,
    distribution: requireLiteral(value, "distribution", "2code-production"),
    releaseBranch: requireLiteral(value, "releaseBranch", "main-2code"),
    githubRepository,
    githubTagPrefix: requireLiteral(value, "githubTagPrefix", "2code-v"),
    appId: requireLiteral(value, "appId", "dev.hafencity.dev.agents"),
    productName: requireLiteral(value, "productName", "2code"),
    executableName: requireLiteral(value, "executableName", "2code"),
    architecture: requireLiteral(value, "architecture", "arm64"),
    teamId,
    feedUrl: feedUrl.replace(/\/$/, ""),
    r2Bucket,
    r2Prefix,
    manifestName: requireLiteral(value, "manifestName", "latest-mac.yml"),
    betaManifestName: requireLiteral(value, "betaManifestName", "beta-mac.yml"),
    updaterCacheDirName: requireLiteral(value, "updaterCacheDirName", "2code-updater"),
    protocolSchemes,
    stagingPercentage,
    minimumLegacyVersion,
  };
}

export async function readReleaseConfig(
  configPath = RELEASE_CONFIG_PATH,
): Promise<TwoCodeReleaseConfig> {
  return parseReleaseConfig(JSON.parse(await NodeFSP.readFile(configPath, "utf8")) as unknown);
}

export function decideRelease(input: {
  readonly action: ReleaseAction;
  readonly desiredVersion: string;
  readonly liveVersion: string;
  readonly liveStagingPercentage: number;
  readonly targetStagingPercentage?: number;
  readonly recoveryVersion?: string;
}): PreflightDecision {
  const comparison = compareStableVersions(input.desiredVersion, input.liveVersion);
  if (input.action !== "recovery" && comparison < 0) {
    throw new Error(
      `Configured 2code version ${input.desiredVersion} is older than live version ${input.liveVersion}.`,
    );
  }

  if (input.action === "recovery") {
    if (!input.recoveryVersion) {
      throw new Error("Recovery requires the version whose rollout should be undone.");
    }
    parseStableSemver(input.recoveryVersion, "Recovery version");
    if (input.recoveryVersion !== input.liveVersion) {
      throw new Error(
        `Recovery version ${input.recoveryVersion} must match live version ${input.liveVersion}.`,
      );
    }
    return {
      decision: "recover",
      shouldBuild: false,
      shouldPublish: true,
      reason: `Restore the manifest captured before ${input.recoveryVersion} was published.`,
    };
  }

  if (input.action === "promote") {
    if (comparison !== 0) {
      throw new Error("Staged rollout promotion requires the configured version to be live.");
    }
    const target = input.targetStagingPercentage;
    if (!Number.isInteger(target) || target === undefined || target < 1 || target > 100) {
      throw new Error("Promotion requires a staging percentage between 1 and 100.");
    }
    if (target <= input.liveStagingPercentage) {
      throw new Error(
        `Promotion percentage ${target} must exceed live percentage ${input.liveStagingPercentage}.`,
      );
    }
    return {
      decision: "promote",
      shouldBuild: false,
      shouldPublish: true,
      reason: `Promote ${input.liveVersion} from ${input.liveStagingPercentage}% to ${target}%.`,
    };
  }

  if (input.action === "dry-run") {
    return {
      decision: "build",
      shouldBuild: true,
      shouldPublish: false,
      reason:
        comparison === 0
          ? `Rebuild live version ${input.liveVersion} without publishing.`
          : `Build ${input.desiredVersion} without publishing.`,
    };
  }

  if (comparison === 0) {
    return {
      decision: "skip",
      shouldBuild: false,
      shouldPublish: false,
      reason: `2code ${input.desiredVersion} is already live.`,
    };
  }

  return {
    decision: "build",
    shouldBuild: true,
    shouldPublish: true,
    reason: `Build and publish 2code ${input.desiredVersion}.`,
  };
}

/**
 * Resolve both mutable updater channels as one release state machine. The
 * channel-aware decisions are what make a beta-first pointer update safe to
 * resume after an interrupted publish, promotion, or recovery.
 */
export function decideReleaseAcrossChannels(input: {
  readonly action: ReleaseAction;
  readonly desiredVersion: string;
  readonly latestVersion: string;
  readonly betaVersion: string;
  readonly latestStagingPercentage: number;
  readonly betaStagingPercentage: number;
  readonly channelsHaveIdenticalManifest: boolean;
  readonly targetStagingPercentage?: number;
  readonly recoveryVersion?: string;
  readonly finalizeIfLive?: boolean;
}): PreflightDecision {
  const channelVersions = [input.latestVersion, input.betaVersion] as const;
  const newestChannelVersion = channelVersions.toSorted(compareStableVersions).at(-1);
  if (!newestChannelVersion) throw new Error("No live 2code channel version was resolved.");

  if (input.action === "recovery") {
    const recoveryVersion = input.recoveryVersion;
    if (!recoveryVersion) {
      throw new Error("Recovery requires the version whose rollout should be undone.");
    }
    parseStableSemver(recoveryVersion, "Recovery version");
    if (recoveryVersion !== input.desiredVersion) {
      throw new Error(
        `Recovery version ${recoveryVersion} must match configured version ${input.desiredVersion}.`,
      );
    }
    for (const channelVersion of channelVersions) {
      if (compareStableVersions(channelVersion, recoveryVersion) > 0) {
        throw new Error(
          `Cannot recover ${recoveryVersion} while a newer channel ${channelVersion} is live.`,
        );
      }
    }
    return {
      decision: "recover",
      shouldBuild: false,
      shouldPublish: true,
      reason: `Restore the manifests captured before ${recoveryVersion} was published.`,
    };
  }

  if (compareStableVersions(input.desiredVersion, newestChannelVersion) < 0) {
    throw new Error(
      `Configured 2code version ${input.desiredVersion} is older than live version ${newestChannelVersion}.`,
    );
  }

  if (input.action === "promote") {
    if (input.latestVersion !== input.betaVersion) {
      throw new Error(
        `latest (${input.latestVersion}) and beta (${input.betaVersion}) must match before promote.`,
      );
    }
    return decideRelease({
      action: "promote",
      desiredVersion: input.desiredVersion,
      liveVersion: input.latestVersion,
      liveStagingPercentage: Math.min(input.latestStagingPercentage, input.betaStagingPercentage),
      ...(input.targetStagingPercentage === undefined
        ? {}
        : { targetStagingPercentage: input.targetStagingPercentage }),
    });
  }

  if (input.action === "dry-run") {
    return decideRelease({
      action: "dry-run",
      desiredVersion: input.desiredVersion,
      liveVersion: newestChannelVersion,
      liveStagingPercentage: Math.max(input.latestStagingPercentage, input.betaStagingPercentage),
    });
  }

  const latestIsDesired = input.latestVersion === input.desiredVersion;
  const betaIsDesired = input.betaVersion === input.desiredVersion;
  if (latestIsDesired && betaIsDesired) {
    if (!input.channelsHaveIdenticalManifest) {
      throw new Error(
        `latest and beta both claim 2code ${input.desiredVersion} but contain different manifests.`,
      );
    }
    return input.finalizeIfLive
      ? {
          decision: "finalize",
          shouldBuild: false,
          shouldPublish: true,
          reason: `Verify and finalize the existing draft for live 2code ${input.desiredVersion}.`,
        }
      : {
          decision: "skip",
          shouldBuild: false,
          shouldPublish: false,
          reason: `2code ${input.desiredVersion} is already live.`,
        };
  }

  if (latestIsDesired !== betaIsDesired) {
    return {
      decision: "resume",
      shouldBuild: false,
      shouldPublish: true,
      reason: `Resume the interrupted 2code ${input.desiredVersion} channel activation using the already-live candidate bytes.`,
    };
  }

  return decideRelease({
    action: "publish",
    desiredVersion: input.desiredVersion,
    liveVersion: newestChannelVersion,
    liveStagingPercentage: Math.max(input.latestStagingPercentage, input.betaStagingPercentage),
  });
}

export function readManifest(raw: string, source: string): UpdateManifest {
  return parseUpdateManifest(raw, source, "2code macOS");
}

export function manifestStagingPercentage(manifest: UpdateManifest): number {
  const configured = manifest.extras.stagingPercentage;
  if (configured === undefined) return 100;
  if (typeof configured !== "number" || !Number.isInteger(configured)) {
    throw new Error("Live 2code manifest has an invalid stagingPercentage.");
  }
  if (configured < 1 || configured > 100) {
    throw new Error("Live 2code manifest stagingPercentage must be between 1 and 100.");
  }
  return configured;
}

export function withStagingPercentage(
  manifest: UpdateManifest,
  stagingPercentage: number,
): UpdateManifest {
  if (!Number.isInteger(stagingPercentage) || stagingPercentage < 1 || stagingPercentage > 100) {
    throw new Error("stagingPercentage must be an integer between 1 and 100.");
  }
  const { stagingPercentage: _previous, ...extras } = manifest.extras;
  return {
    ...manifest,
    extras: stagingPercentage === 100 ? extras : { ...extras, stagingPercentage },
  };
}

export function expectedArtifactNames(config: TwoCodeReleaseConfig): readonly [string, string] {
  return [
    `2code-${config.version}-${config.architecture}-mac.zip`,
    `2code-${config.version}-${config.architecture}.dmg`,
  ];
}

function assertSafeManifestFilename(value: string): string {
  const basename = NodePath.basename(value);
  if (basename !== value || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Unsafe file URL '${value}' in 2code update manifest.`);
  }
  return basename;
}

export async function digestFile(
  path: string,
): Promise<{ sha512: string; sha512Hex: string; size: number }> {
  const data = await NodeFSP.readFile(path);
  return {
    sha512: NodeCrypto.createHash("sha512").update(data).digest("base64"),
    sha512Hex: NodeCrypto.createHash("sha512").update(data).digest("hex"),
    size: data.byteLength,
  };
}

function contentTypeFor(name: string): string {
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".blockmap")) return "application/octet-stream";
  if (name.endsWith(".yml")) return "application/yaml";
  return "application/octet-stream";
}

export async function prepareReleaseArtifacts(input: {
  readonly config: TwoCodeReleaseConfig;
  readonly artifactDirectory: string;
  readonly sourceCommit: string;
}): Promise<TwoCodeReleasePlan> {
  const manifestPath = NodePath.join(input.artifactDirectory, input.config.manifestName);
  const generated = readManifest(await NodeFSP.readFile(manifestPath, "utf8"), manifestPath);
  if (generated.version !== input.config.version) {
    throw new Error(
      `Generated manifest version ${generated.version} does not match configured version ${input.config.version}.`,
    );
  }

  const expectedNames = expectedArtifactNames(input.config);
  const generatedNames = generated.files
    .map((file) => assertSafeManifestFilename(file.url))
    .toSorted();
  if (JSON.stringify(generatedNames) !== JSON.stringify([...expectedNames].toSorted())) {
    throw new Error(
      `Generated manifest files ${generatedNames.join(", ")} do not match expected legacy files ${expectedNames.join(", ")}.`,
    );
  }

  const payloads: PreparedPayload[] = [];
  const preparedFiles = [];
  for (const file of generated.files) {
    const localName = assertSafeManifestFilename(file.url);
    const artifactPath = NodePath.join(input.artifactDirectory, localName);
    const digest = await digestFile(artifactPath);
    const objectDirectory = `objects/${digest.sha512Hex}`;
    const remotePath = `${objectDirectory}/${localName}`;
    preparedFiles.push({ url: remotePath, sha512: digest.sha512, size: digest.size });
    payloads.push({
      localName,
      remotePath,
      sha512: digest.sha512,
      size: digest.size,
      contentType: contentTypeFor(localName),
    });

    const blockmapName = `${localName}.blockmap`;
    const blockmapPath = NodePath.join(input.artifactDirectory, blockmapName);
    const blockmapDigest = await digestFile(blockmapPath);
    payloads.push({
      localName: blockmapName,
      remotePath: `${remotePath}.blockmap`,
      sha512: blockmapDigest.sha512,
      size: blockmapDigest.size,
      contentType: contentTypeFor(blockmapName),
    });
  }

  const preparedManifest = withStagingPercentage(
    { ...generated, files: preparedFiles },
    input.config.stagingPercentage,
  );
  const serializedManifest = serializeUpdateManifest(preparedManifest, {
    platformLabel: "2code macOS",
  });
  const temporaryManifestPath = `${manifestPath}.tmp`;
  await NodeFSP.writeFile(temporaryManifestPath, serializedManifest, "utf8");
  await NodeFSP.rename(temporaryManifestPath, manifestPath);

  const configSha256 = NodeCrypto.createHash("sha256")
    .update(JSON.stringify(input.config))
    .digest("hex");
  const manifestSha512 = NodeCrypto.createHash("sha512")
    .update(serializedManifest)
    .digest("base64");
  const plan: TwoCodeReleasePlan = {
    schemaVersion: 1,
    version: input.config.version,
    tag: `${input.config.githubTagPrefix}${input.config.version}`,
    sourceCommit: input.sourceCommit,
    configSha256,
    manifestName: input.config.manifestName,
    manifestSha512,
    stagingPercentage: input.config.stagingPercentage,
    payloads,
  };
  await NodeFSP.writeFile(
    NodePath.join(input.artifactDirectory, RELEASE_PLAN_NAME),
    `${JSON.stringify(plan, null, 2)}\n`,
    "utf8",
  );
  return plan;
}

export function parseReleasePlan(value: unknown): TwoCodeReleasePlan {
  assertRecord(value, "2code release plan");
  if (
    value.schemaVersion !== 1 ||
    typeof value.version !== "string" ||
    typeof value.tag !== "string" ||
    typeof value.sourceCommit !== "string" ||
    typeof value.configSha256 !== "string" ||
    value.manifestName !== "latest-mac.yml" ||
    typeof value.manifestSha512 !== "string" ||
    typeof value.stagingPercentage !== "number" ||
    !Array.isArray(value.payloads)
  ) {
    throw new Error("Invalid 2code release plan.");
  }
  const payloads = value.payloads.map((payload) => {
    assertRecord(payload, "2code release payload");
    if (
      typeof payload.localName !== "string" ||
      typeof payload.remotePath !== "string" ||
      typeof payload.sha512 !== "string" ||
      typeof payload.size !== "number" ||
      typeof payload.contentType !== "string"
    ) {
      throw new Error("Invalid payload in 2code release plan.");
    }
    assertSafeManifestFilename(payload.localName);
    validateSafeObjectPath(payload.remotePath, "payload remotePath");
    return payload as unknown as PreparedPayload;
  });
  return { ...(value as unknown as TwoCodeReleasePlan), payloads };
}

export async function readReleasePlan(artifactDirectory: string): Promise<TwoCodeReleasePlan> {
  return parseReleasePlan(
    JSON.parse(
      await NodeFSP.readFile(NodePath.join(artifactDirectory, RELEASE_PLAN_NAME), "utf8"),
    ) as unknown,
  );
}

export async function verifyPreparedArtifacts(input: {
  readonly config: TwoCodeReleaseConfig;
  readonly artifactDirectory: string;
}): Promise<TwoCodeReleasePlan> {
  const plan = await readReleasePlan(input.artifactDirectory);
  if (
    plan.version !== input.config.version ||
    plan.tag !== `${input.config.githubTagPrefix}${input.config.version}`
  ) {
    throw new Error("Release plan version/tag does not match release config.");
  }
  const expectedConfigHash = NodeCrypto.createHash("sha256")
    .update(JSON.stringify(input.config))
    .digest("hex");
  if (plan.configSha256 !== expectedConfigHash) {
    throw new Error("Release plan was built from a different 2code release config.");
  }

  const manifestPath = NodePath.join(input.artifactDirectory, plan.manifestName);
  const manifestRaw = await NodeFSP.readFile(manifestPath, "utf8");
  const manifestDigest = NodeCrypto.createHash("sha512").update(manifestRaw).digest("base64");
  if (manifestDigest !== plan.manifestSha512) {
    throw new Error("Prepared manifest hash does not match release plan.");
  }
  const manifest = readManifest(manifestRaw, manifestPath);
  if (
    manifest.version !== plan.version ||
    manifestStagingPercentage(manifest) !== plan.stagingPercentage
  ) {
    throw new Error("Prepared manifest metadata does not match release plan.");
  }

  const manifestPayloads = plan.payloads.filter(
    (payload) => !payload.localName.endsWith(".blockmap"),
  );
  if (
    JSON.stringify(manifest.files.map((file) => file.url).toSorted()) !==
    JSON.stringify(manifestPayloads.map((payload) => payload.remotePath).toSorted())
  ) {
    throw new Error("Prepared manifest file URLs do not match release plan payloads.");
  }

  for (const payload of plan.payloads) {
    const digest = await digestFile(NodePath.join(input.artifactDirectory, payload.localName));
    if (digest.sha512 !== payload.sha512 || digest.size !== payload.size) {
      throw new Error(`Payload ${payload.localName} does not match its release plan hash/size.`);
    }
    const manifestFile = manifest.files.find((file) => file.url === payload.remotePath);
    if (
      manifestFile &&
      (manifestFile.sha512 !== payload.sha512 || manifestFile.size !== payload.size)
    ) {
      throw new Error(`Manifest hash/size for ${payload.localName} is incorrect.`);
    }
  }
  return plan;
}

export function serializeManifestWithRollout(
  raw: string,
  source: string,
  percentage: number,
): string {
  return serializeUpdateManifest(withStagingPercentage(readManifest(raw, source), percentage), {
    platformLabel: "2code macOS",
  });
}

export function sha512Base64(value: string | Buffer): string {
  return NodeCrypto.createHash("sha512").update(value).digest("base64");
}

export function sha512Hex(value: string | Buffer): string {
  return NodeCrypto.createHash("sha512").update(value).digest("hex");
}
