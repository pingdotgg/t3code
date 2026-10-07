/**
 * Shared config for the release scripts. Read from env vars set by the
 * reusable workflow so the same scripts work for every consumer.
 *
 * ALCHEMY_PUBLISHABLE_DIRS   JSON array of package dirs (relative to repo root)
 * ALCHEMY_PUBLISHABLE_NAMES  JSON array of npm names (parallel to dirs)
 * ALCHEMY_CURRENT_VERSION    Anchor for prerelease bumps (e.g. "2.0.0")
 * ALCHEMY_REPO               `<owner>/<repo>` for changelog/release-note URLs
 * GITHUB_OUTPUT              GitHub Actions output file (used by output())
 */
import { appendFileSync } from "node:fs";

export type Package = {
  dir: string;
  name: string;
  project: string;
  install: string;
  runner: string;
  artifact: string;
};

export type PrPackagePlan = {
  packages: Package[];
  publishable_names: string[];
  tags: string[];
  dependency_tag: string;
  short: string;
  install_host: string;
};

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    fail(`Required env var ${name} is unset or empty`);
  }
  return v.trim();
}

export function output(name: string, value: unknown): void {
  const encoded = typeof value === "string" ? value : JSON.stringify(value);
  appendFileSync(required("GITHUB_OUTPUT"), `${name}=${encoded}\n`);
}

export function jsonArray<T>(name: string, value: string): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (e) {
    fail(`${name} is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    fail(`${name} must be a JSON array`);
  }
  return parsed as T[];
}

function parseJsonArray(name: string, value: string): string[] {
  const parsed = jsonArray<unknown>(name, value);
  if (!parsed.every((x) => typeof x === "string" && x.trim().length > 0)) {
    fail(`${name} must be a JSON array of non-empty strings`);
  }
  return parsed as string[];
}

export function publishableDirs(): string[] {
  return parseJsonArray(
    "ALCHEMY_PUBLISHABLE_DIRS",
    required("ALCHEMY_PUBLISHABLE_DIRS"),
  );
}

export function publishableNames(): string[] {
  return parseJsonArray(
    "ALCHEMY_PUBLISHABLE_NAMES",
    required("ALCHEMY_PUBLISHABLE_NAMES"),
  );
}

export function currentVersion(): string {
  const v = required("ALCHEMY_CURRENT_VERSION");
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    console.error(`ALCHEMY_CURRENT_VERSION must be x.y.z (got: ${v})`);
    process.exit(1);
  }
  return v;
}

export function repo(): string {
  const r = required("ALCHEMY_REPO");
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) {
    console.error(`ALCHEMY_REPO must be <owner>/<repo> (got: ${r})`);
    process.exit(1);
  }
  return r;
}
