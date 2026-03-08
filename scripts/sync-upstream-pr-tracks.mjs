#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const configPath = path.join(repoRoot, "config", "upstream-pr-tracks.json");

function runGit(args, options = {}) {
  const output = execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  return typeof output === "string" ? output.trim() : "";
}

function tryRunGit(args) {
  try {
    return runGit(args);
  } catch {
    return null;
  }
}

function deriveRepoUrl(remoteName) {
  let remoteUrl = tryRunGit(["remote", "get-url", remoteName]);
  if (!remoteUrl) return null;

  // Strip trailing .git before matching so it never leaks into the result.
  remoteUrl = remoteUrl.replace(/\.git$/, "");

  // Handle scp-style SSH (git@github.com:owner/repo)
  const scpMatch = remoteUrl.match(/git@([^:]+):(.+)$/);
  if (scpMatch) return `https://${scpMatch[1]}/${scpMatch[2]}`;

  // Handle ssh:// protocol (ssh://git@github.com/owner/repo)
  const sshMatch = remoteUrl.match(/^ssh:\/\/[^@]+@([^/]+)\/(.+)$/);
  if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2]}`;

  // Handle HTTPS (https://github.com/owner/repo)
  const httpsMatch = remoteUrl.match(/^https?:\/\/(.+)$/);
  if (httpsMatch) return `https://${httpsMatch[1]}`;

  return null;
}

function loadConfig() {
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid upstream PR tracking config.");
  }
  if (!Array.isArray(parsed.trackedPrs) || parsed.trackedPrs.length === 0) {
    throw new Error("No tracked PRs configured.");
  }
  // Derive the repo URL from the upstream remote instead of hardcoding it.
  parsed.repoUrl = deriveRepoUrl(parsed.upstreamRemote) ?? deriveRepoUrl(parsed.forkRemote);
  if (!parsed.repoUrl) {
    throw new Error(
      `Could not derive repo URL from remotes "${parsed.upstreamRemote}" or "${parsed.forkRemote}". ` +
        "Ensure at least one remote uses an HTTPS, scp-style SSH, or ssh:// URL.",
    );
  }
  return parsed;
}

function splitLines(output) {
  if (!output) return [];
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatSection(title) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
}

function getComparisonSummary(baseRef, headRef) {
  const mergeBase = tryRunGit(["merge-base", baseRef, headRef]);
  const uniqueCommits = splitLines(
    tryRunGit([
      "log",
      "--right-only",
      "--cherry-pick",
      "--no-merges",
      "--oneline",
      `${baseRef}...${headRef}`,
    ]),
  );
  const diffStat = tryRunGit(["diff", "--stat", `${baseRef}...${headRef}`]) || "(no diff)";
  return {
    mergeBase,
    uniqueCommits,
    diffStat,
  };
}

function main() {
  const config = loadConfig();
  const baseBranch = process.argv[2] || config.baseBranch;
  const integrationBranch = config.integrationBranch;

  console.log("Refreshing upstream PR tracking branches");
  console.log(`Repo: ${repoRoot}`);
  console.log(`Upstream remote: ${config.upstreamRemote}`);
  console.log(`Fork remote: ${config.forkRemote}`);
  console.log(`Base branch: ${baseBranch}`);
  console.log(`Integration branch: ${integrationBranch}`);

  runGit(["fetch", config.upstreamRemote]);

  for (const pr of config.trackedPrs) {
    const prRef = `pull/${pr.number}/head:${pr.localBranch}`;
    console.log(`\nFetching PR #${pr.number} into ${pr.localBranch}`);
    runGit(["fetch", config.upstreamRemote, prRef]);

    const branchSha = runGit(["rev-parse", pr.localBranch]);
    const baseSummary = getComparisonSummary(baseBranch, pr.localBranch);
    const integrationSummary = getComparisonSummary(integrationBranch, pr.localBranch);

    formatSection(`PR #${pr.number}: ${pr.title}`);
    console.log(`URL: ${config.repoUrl}/pull/${pr.number}`);
    console.log(`Tracking branch: ${pr.localBranch}`);
    console.log(`Branch SHA: ${branchSha}`);
    console.log(`Merge base with ${baseBranch}: ${baseSummary.mergeBase ?? "(missing)"}`);
    console.log(`Unique commits vs ${baseBranch}: ${baseSummary.uniqueCommits.length}`);
    if (baseSummary.uniqueCommits.length > 0) {
      for (const line of baseSummary.uniqueCommits) {
        console.log(`  ${line}`);
      }
    } else {
      console.log("  none");
    }

    console.log(`Merge base with ${integrationBranch}: ${integrationSummary.mergeBase ?? "(missing)"}`);
    console.log(`Pending commits vs ${integrationBranch}: ${integrationSummary.uniqueCommits.length}`);
    if (integrationSummary.uniqueCommits.length > 0) {
      for (const line of integrationSummary.uniqueCommits) {
        console.log(`  ${line}`);
      }
    } else {
      console.log("  none");
    }

    console.log(`Diff stat vs ${baseBranch}:`);
    console.log(baseSummary.diffStat);
    console.log(`Diff stat vs ${integrationBranch}:`);
    console.log(integrationSummary.diffStat);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`sync-upstream-pr-tracks failed: ${message}`);
  process.exitCode = 1;
}
