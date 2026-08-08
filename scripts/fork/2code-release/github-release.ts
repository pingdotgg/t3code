#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - GitHub release delivery is an explicitly guarded host-side CI tool.

import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  digestFile,
  readReleasePlan,
  readReleaseConfig,
  RELEASE_PLAN_NAME,
  verifyPreparedArtifacts,
  type TwoCodeReleaseConfig,
  type TwoCodeReleasePlan,
} from "./release-core.ts";

interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
}

interface ReleaseResponse {
  readonly draft: boolean;
  readonly tagName: string;
  readonly targetCommitish: string;
  readonly assets: readonly ReleaseAsset[];
}

function run(
  command: string,
  args: readonly string[],
  options: { readonly allowFailure?: boolean; readonly redactFailure?: boolean } = {},
): { status: number; stdout: string; stderr: string } {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const status = result.status ?? 1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? (result.error ? String(result.error) : "");
  if (!options.allowFailure && status !== 0) {
    throw new Error(
      `${command} failed with exit code ${status}: ${options.redactFailure ? "redacted" : (stderr || stdout).trim()}`,
    );
  }
  return { status, stdout, stderr };
}

function requireGitHubGuard(config: TwoCodeReleaseConfig): void {
  const required = [
    ["GITHUB_ACTIONS", "true"],
    ["GITHUB_REPOSITORY", config.githubRepository],
    ["GITHUB_REF_NAME", config.releaseBranch],
    ["T3CODE_2CODE_ALLOW_GITHUB_RELEASE", "I_UNDERSTAND_THIS_PUBLISHES_2CODE"],
  ] as const;
  for (const [name, expected] of required) {
    if (process.env[name] !== expected) {
      throw new Error(`Refusing GitHub release mutation: ${name} must equal '${expected}'.`);
    }
  }
  if (!process.env.GH_TOKEN) {
    throw new Error("Refusing GitHub release mutation: GH_TOKEN is missing.");
  }
}

export function githubReleaseAssetNames(plan: TwoCodeReleasePlan): readonly string[] {
  return [
    RELEASE_PLAN_NAME,
    plan.manifestName,
    ...plan.payloads.map((payload) => payload.localName),
  ].toSorted();
}

function parseReleaseResponse(raw: string): ReleaseResponse {
  const value = JSON.parse(raw) as {
    draft?: unknown;
    tag_name?: unknown;
    target_commitish?: unknown;
    assets?: Array<{ name?: unknown; url?: unknown }>;
  };
  if (
    typeof value.draft !== "boolean" ||
    typeof value.tag_name !== "string" ||
    typeof value.target_commitish !== "string" ||
    !Array.isArray(value.assets)
  ) {
    throw new Error("GitHub returned an invalid release response.");
  }
  const assets = value.assets.map((asset) => {
    if (typeof asset.name !== "string" || typeof asset.url !== "string") {
      throw new Error("GitHub returned invalid release asset metadata.");
    }
    return { name: asset.name, url: asset.url };
  });
  return {
    draft: value.draft,
    tagName: value.tag_name,
    targetCommitish: value.target_commitish,
    assets,
  };
}

function getRelease(config: TwoCodeReleaseConfig): ReleaseResponse | undefined {
  const tag = `${config.githubTagPrefix}${config.version}`;
  const result = run(
    "gh",
    ["api", `repos/${config.githubRepository}/releases/tags/${encodeURIComponent(tag)}`],
    { allowFailure: true },
  );
  if (result.status === 0) return parseReleaseResponse(result.stdout);
  if (/(?:404|Not Found)/i.test(`${result.stdout}\n${result.stderr}`)) return undefined;
  throw new Error(`Could not inspect GitHub release ${tag}: ${result.stderr.trim()}`);
}

function resolveTagCommit(config: TwoCodeReleaseConfig, tag: string): string | undefined {
  const ref = run(
    "gh",
    ["api", `repos/${config.githubRepository}/git/ref/tags/${encodeURIComponent(tag)}`],
    { allowFailure: true },
  );
  if (ref.status !== 0) {
    if (/(?:404|Not Found)/i.test(`${ref.stdout}\n${ref.stderr}`)) return undefined;
    throw new Error(`Could not inspect Git tag ${tag}: ${ref.stderr.trim()}`);
  }
  const parsed = JSON.parse(ref.stdout) as { object?: { type?: unknown; sha?: unknown } };
  if (typeof parsed.object?.sha !== "string" || typeof parsed.object.type !== "string") {
    throw new Error(`GitHub returned invalid tag metadata for ${tag}.`);
  }
  if (parsed.object.type === "commit") return parsed.object.sha;
  if (parsed.object.type !== "tag")
    throw new Error(`Unsupported Git tag target ${parsed.object.type}.`);
  const annotated = run("gh", [
    "api",
    `repos/${config.githubRepository}/git/tags/${parsed.object.sha}`,
  ]);
  const annotatedJson = JSON.parse(annotated.stdout) as {
    object?: { type?: unknown; sha?: unknown };
  };
  if (annotatedJson.object?.type !== "commit" || typeof annotatedJson.object.sha !== "string") {
    throw new Error(`Annotated Git tag ${tag} does not point directly to a commit.`);
  }
  return annotatedJson.object.sha;
}

async function downloadExistingAsset(asset: ReleaseAsset, destination: string): Promise<void> {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("GH_TOKEN is missing.");
  run(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--header",
      "Accept: application/octet-stream",
      "--header",
      `Authorization: Bearer ${token}`,
      "--output",
      destination,
      asset.url,
    ],
    { redactFailure: true },
  );
}

async function prepareDraft(
  config: TwoCodeReleaseConfig,
  artifactDirectory: string,
): Promise<void> {
  const plan = await verifyPreparedArtifacts({ config, artifactDirectory });
  const tagCommit = resolveTagCommit(config, plan.tag);
  if (tagCommit && tagCommit !== plan.sourceCommit) {
    throw new Error(
      `Tag ${plan.tag} points to ${tagCommit}, not release commit ${plan.sourceCommit}; refusing reuse.`,
    );
  }
  let release = getRelease(config);
  if (!release) {
    run("gh", [
      "release",
      "create",
      plan.tag,
      "--repo",
      config.githubRepository,
      "--target",
      plan.sourceCommit,
      "--title",
      `2code v${plan.version}`,
      "--notes",
      `2code desktop release built from ${plan.sourceCommit}. The legacy R2 feed remains the authoritative updater channel.`,
      "--draft",
    ]);
    release = getRelease(config);
  }
  if (!release) throw new Error(`Draft GitHub release ${plan.tag} could not be created.`);
  if (release.tagName !== plan.tag) {
    throw new Error(`GitHub release tag ${release.tagName} does not match ${plan.tag}.`);
  }
  if (!tagCommit && release.targetCommitish !== plan.sourceCommit) {
    throw new Error(
      `Draft ${plan.tag} targets ${release.targetCommitish}, not release commit ${plan.sourceCommit}.`,
    );
  }
  const alreadyPublished = !release.draft;

  const expectedAssets = githubReleaseAssetNames(plan);
  const temporaryDirectory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "2code-gh-release-"),
  );
  try {
    for (const name of expectedAssets) {
      const localPath = NodePath.join(artifactDirectory, name);
      const localDigest = await digestFile(localPath);
      const existing = release.assets.find((asset) => asset.name === name);
      if (existing) {
        const existingPath = NodePath.join(
          temporaryDirectory,
          `${NodeCrypto.randomUUID()}-${name}`,
        );
        await downloadExistingAsset(existing, existingPath);
        const existingDigest = await digestFile(existingPath);
        if (
          localDigest.sha512 !== existingDigest.sha512 ||
          localDigest.size !== existingDigest.size
        ) {
          throw new Error(`GitHub release asset ${name} exists with different bytes.`);
        }
        console.log(`GitHub release asset already matches: ${name}`);
        continue;
      }
      if (alreadyPublished) {
        throw new Error(`Published GitHub release ${plan.tag} is missing asset ${name}.`);
      }
      run("gh", ["release", "upload", plan.tag, localPath, "--repo", config.githubRepository]);
    }
  } finally {
    await NodeFSP.rm(temporaryDirectory, { recursive: true, force: true });
  }
  console.log(
    alreadyPublished
      ? `GitHub release ${plan.tag} is already public with identical assets.`
      : `Prepared draft GitHub release ${plan.tag}.`,
  );
}

async function downloadUrl(url: string, destination: string): Promise<void> {
  const target = new URL(url);
  target.searchParams.set("release_verify", NodeCrypto.randomUUID());
  run("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--retry",
    "4",
    "--retry-all-errors",
    "--output",
    destination,
    target.href,
  ]);
}

async function verifyDraftAgainstLiveFeed(
  config: TwoCodeReleaseConfig,
  release: ReleaseResponse,
): Promise<void> {
  const temporaryDirectory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "2code-gh-finalize-"),
  );
  try {
    const planAsset = release.assets.find((asset) => asset.name === RELEASE_PLAN_NAME);
    if (!planAsset) {
      throw new Error(`GitHub release is missing ${RELEASE_PLAN_NAME}.`);
    }
    await downloadExistingAsset(planAsset, NodePath.join(temporaryDirectory, RELEASE_PLAN_NAME));
    const plan = await readReleasePlan(temporaryDirectory);
    const expectedAssets = githubReleaseAssetNames(plan);
    const actualAssets = release.assets.map((asset) => asset.name).toSorted();
    if (JSON.stringify(actualAssets) !== JSON.stringify(expectedAssets)) {
      throw new Error("GitHub release assets do not exactly match the verified release plan.");
    }
    for (const name of expectedAssets) {
      if (name === RELEASE_PLAN_NAME) continue;
      const asset = release.assets.find((candidate) => candidate.name === name);
      if (!asset) throw new Error(`GitHub release is missing ${name}.`);
      await downloadExistingAsset(asset, NodePath.join(temporaryDirectory, name));
    }
    await verifyPreparedArtifacts({ config, artifactDirectory: temporaryDirectory });

    const tagCommit = resolveTagCommit(config, plan.tag);
    if (
      (tagCommit !== undefined && tagCommit !== plan.sourceCommit) ||
      (tagCommit === undefined && release.targetCommitish !== plan.sourceCommit)
    ) {
      throw new Error(
        `Release ${plan.tag} targets ${tagCommit ?? release.targetCommitish}, not verified release commit ${plan.sourceCommit}.`,
      );
    }

    const localManifest = await NodeFSP.readFile(
      NodePath.join(temporaryDirectory, plan.manifestName),
      "utf8",
    );
    for (const manifestName of [config.manifestName, config.betaManifestName]) {
      const livePath = NodePath.join(temporaryDirectory, `live-${manifestName}`);
      await downloadUrl(`${config.feedUrl}/${manifestName}`, livePath);
      if ((await NodeFSP.readFile(livePath, "utf8")) !== localManifest) {
        throw new Error(
          `Live ${manifestName} does not match the verified GitHub release manifest.`,
        );
      }
    }
  } finally {
    await NodeFSP.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function finalizeRelease(config: TwoCodeReleaseConfig): Promise<void> {
  const tag = `${config.githubTagPrefix}${config.version}`;
  const release = getRelease(config);
  if (!release) throw new Error(`Cannot finalize missing GitHub release ${tag}.`);
  await verifyDraftAgainstLiveFeed(config, release);
  if (!release.draft) {
    console.log(`GitHub release ${tag} is already public and matches both live channels.`);
    return;
  }
  run("gh", [
    "release",
    "edit",
    tag,
    "--repo",
    config.githubRepository,
    "--draft=false",
    "--latest",
  ]);
  console.log(`Published GitHub release ${tag}.`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "prepare" && command !== "finalize") {
    throw new Error("Expected command prepare or finalize.");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid argument sequence near '${key ?? "<end>"}'.`);
    }
    values.set(key.slice(2), value);
  }
  const config = await readReleaseConfig(
    values.get("config") ?? "distributions/2code/release.json",
  );
  requireGitHubGuard(config);
  if (command === "prepare") {
    const artifactDirectory = values.get("artifact-dir");
    if (!artifactDirectory) throw new Error("prepare requires --artifact-dir.");
    await prepareDraft(config, NodePath.resolve(artifactDirectory));
  } else {
    await finalizeRelease(config);
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
