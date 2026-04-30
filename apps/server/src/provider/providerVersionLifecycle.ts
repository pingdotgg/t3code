import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@t3tools/contracts";

import { compareCliVersions } from "./cliVersion.ts";

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;
const LATEST_VERSION_TIMEOUT_MS = 4_000;
const PROVIDER_UPDATE_ACTION_TOAST_MESSAGE = "Install the update now or review provider settings.";

type VersionLifecycleProvider = "codex" | "claudeAgent" | "cursor" | "opencode";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");

export interface ProviderVersionLifecycle {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly updateCommand: string | null;
  readonly updateExecutable: string | null;
  readonly updateArgs: ReadonlyArray<string>;
  readonly updateLockKey: string | null;
}

const PROVIDER_VERSION_LIFECYCLES = {
  codex: {
    provider: CODEX_DRIVER,
    packageName: "@openai/codex",
    updateCommand: "npm install -g @openai/codex@latest",
    updateExecutable: "npm",
    updateArgs: ["install", "-g", "@openai/codex@latest"],
    updateLockKey: "npm-global",
  },
  claudeAgent: {
    provider: CLAUDE_AGENT_DRIVER,
    packageName: "@anthropic-ai/claude-code",
    updateCommand: "npm install -g @anthropic-ai/claude-code@latest",
    updateExecutable: "npm",
    updateArgs: ["install", "-g", "@anthropic-ai/claude-code@latest"],
    updateLockKey: "npm-global",
  },
  cursor: {
    provider: CURSOR_DRIVER,
    packageName: null,
    updateCommand: "agent update",
    updateExecutable: "agent",
    updateArgs: ["update"],
    updateLockKey: "cursor-agent",
  },
  opencode: {
    provider: OPENCODE_DRIVER,
    packageName: "opencode-ai",
    updateCommand: "npm install -g opencode-ai@latest",
    updateExecutable: "npm",
    updateArgs: ["install", "-g", "opencode-ai@latest"],
    updateLockKey: "npm-global",
  },
} as const satisfies Record<VersionLifecycleProvider, ProviderVersionLifecycle>;

interface LatestVersionCacheEntry {
  readonly expiresAt: number;
  readonly version: string | null;
}

const latestVersionCache = new Map<string, LatestVersionCacheEntry>();

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isVersionLifecycleProvider(provider: string): provider is VersionLifecycleProvider {
  return provider in PROVIDER_VERSION_LIFECYCLES;
}

export function getProviderVersionLifecycle(
  provider: ProviderDriverKind,
): ProviderVersionLifecycle {
  const providerKey = String(provider);
  if (isVersionLifecycleProvider(providerKey)) {
    return PROVIDER_VERSION_LIFECYCLES[providerKey];
  }
  return {
    provider,
    packageName: null,
    updateCommand: null,
    updateExecutable: null,
    updateArgs: [],
    updateLockKey: null,
  };
}

function deriveVersionAdvisory(input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
}): Pick<ServerProviderVersionAdvisory, "status" | "message"> {
  if (!input.currentVersion) {
    return { status: "unknown", message: null };
  }
  if (!input.latestVersion) {
    return { status: "unknown", message: null };
  }
  if (compareCliVersions(input.currentVersion, input.latestVersion) < 0) {
    return {
      status: "behind_latest",
      message: PROVIDER_UPDATE_ACTION_TOAST_MESSAGE,
    };
  }
  return { status: "current", message: null };
}

export function createProviderVersionAdvisory(input: {
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
  readonly latestVersion?: string | null;
  readonly checkedAt?: string | null;
}): ServerProviderVersionAdvisory {
  const lifecycle = getProviderVersionLifecycle(input.driver);
  const latestVersion = input.latestVersion ?? null;
  const advisory = deriveVersionAdvisory({
    currentVersion: input.currentVersion,
    latestVersion,
  });

  return {
    status: advisory.status,
    currentVersion: input.currentVersion,
    latestVersion,
    updateCommand: lifecycle.updateCommand,
    canUpdate: lifecycle.updateExecutable !== null,
    checkedAt: input.checkedAt ?? null,
    message: advisory.message,
  };
}

async function fetchNpmLatestVersion(packageName: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LATEST_VERSION_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
      {
        signal: controller.signal,
        headers: { accept: "application/json" },
      },
    );
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { version?: unknown };
    return nonEmptyString(payload.version);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveLatestProviderVersion(
  provider: ProviderDriverKind,
): Promise<string | null> {
  const lifecycle = getProviderVersionLifecycle(provider);
  if (!lifecycle.packageName) {
    return null;
  }

  const cached = latestVersionCache.get(lifecycle.packageName);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.version;
  }

  const version = await fetchNpmLatestVersion(lifecycle.packageName);
  latestVersionCache.set(lifecycle.packageName, {
    expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
    version,
  });
  return version;
}

export async function enrichProviderSnapshotWithVersionAdvisory(
  snapshot: ServerProvider,
): Promise<ServerProvider> {
  if (!snapshot.enabled || !snapshot.installed || !snapshot.version) {
    return {
      ...snapshot,
      versionAdvisory: createProviderVersionAdvisory({
        driver: snapshot.driver,
        currentVersion: snapshot.version,
        checkedAt: snapshot.checkedAt,
      }),
    };
  }

  const latestVersion = await resolveLatestProviderVersion(snapshot.driver);
  return {
    ...snapshot,
    versionAdvisory: createProviderVersionAdvisory({
      driver: snapshot.driver,
      currentVersion: snapshot.version,
      latestVersion,
      checkedAt: new Date().toISOString(),
    }),
  };
}
