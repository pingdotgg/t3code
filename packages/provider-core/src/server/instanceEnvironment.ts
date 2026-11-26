import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import { stripAppImageRuntimeEnv } from "@t3tools/shared/appImageRuntimeEnv";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { expandHomeVariable } from "./pathExpansion.ts";

/**
 * Optional fiber-scoped environment overrides merged on top of provider instance environment
 * variables during session open (used e.g. for per-session Team Server loopback proxy tokens).
 */
export const ProviderSessionEnvironmentOverride = Context.Reference<
  Readonly<Record<string, string>>
>("t3/provider-core/ProviderSessionEnvironmentOverride", {
  defaultValue: () => ({}),
});

const TEAM_GITHUB_BROKER_TOKEN_ENV = "T3_TEAM_GH_BROKER_TOKEN";
const TEAM_GITHUB_STRIPPED_ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;
const TEAM_GITHUB_AUTHOR_ENV_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

function stripEnvKey(env: NodeJS.ProcessEnv, key: string, caseInsensitive: boolean): void {
  if (!caseInsensitive) {
    delete env[key];
    return;
  }
  const upper = key.toUpperCase();
  for (const existing of Object.keys(env)) {
    if (existing.toUpperCase() === upper) {
      delete env[existing];
    }
  }
}

function stripTeamGitHubAmbientEnv(
  env: NodeJS.ProcessEnv,
  override: Readonly<Record<string, string>>,
  caseInsensitive: boolean,
): void {
  if (!(TEAM_GITHUB_BROKER_TOKEN_ENV in override)) return;
  for (const key of TEAM_GITHUB_STRIPPED_ENV_KEYS) {
    stripEnvKey(env, key, caseInsensitive);
  }
  if (!("GIT_AUTHOR_NAME" in override)) {
    for (const key of TEAM_GITHUB_AUTHOR_ENV_KEYS) {
      stripEnvKey(env, key, caseInsensitive);
    }
  }
}

export function applyProviderSessionEnvironmentOverride(
  base: NodeJS.ProcessEnv,
  override?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  if (!override) return base;
  const entries = Object.entries(override);
  if (entries.length === 0) return base;
  const next: NodeJS.ProcessEnv = { ...base };
  stripTeamGitHubAmbientEnv(next, override, true);
  for (const [key, value] of entries) {
    next[key] = value;
  }
  return next;
}

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  // Commands the agent runs inherit this env; the AppImage mount's libraries would shadow the system's.
  const hostEnv = stripAppImageRuntimeEnv(baseEnv);
  const sessionOverride = yield* ProviderSessionEnvironmentOverride;
  const sessionOverrideEntries = Object.entries(sessionOverride);
  if ((!environment || environment.length === 0) && sessionOverrideEntries.length === 0) {
    return hostEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const windows = (yield* HostProcess.Platform) === "win32";
  const next: NodeJS.ProcessEnv = { ...hostEnv };
  if (environment) {
    for (const variable of environment) {
      // An unresolved secret reference carries no value; the registry resolves it for the provider.
      if (typeof variable.value !== "string") continue;
      // Windows reads names without regard to case, and a child gets the first spelling in sort
      // order. Upper case sorts first, so the configured value wins even where a spawn merges the
      // parent environment back in.
      const name = windows ? variable.name.toUpperCase() : variable.name;
      if (windows) {
        for (const inherited of Object.keys(next)) {
          if (inherited.toUpperCase() === name) delete next[inherited];
        }
      }
      next[name] = expandHomeVariable(name, variable.value, home);
    }
  }
  stripTeamGitHubAmbientEnv(next, sessionOverride, windows);
  for (const [rawName, value] of sessionOverrideEntries) {
    const name = windows ? rawName.toUpperCase() : rawName;
    if (windows) {
      for (const inherited of Object.keys(next)) {
        if (inherited.toUpperCase() === name) delete next[inherited];
      }
    }
    next[name] = expandHomeVariable(name, value, home);
  }
  return next;
});
