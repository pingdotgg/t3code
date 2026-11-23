import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomeVariable } from "./pathExpansion.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const windows = (yield* HostProcess.Platform) === "win32";
  const next: NodeJS.ProcessEnv = { ...baseEnv };
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
  return next;
});

/**
 * `derived` was built from `base`, a copy of `host` taken at that moment. Returns `derived` plus
 * what the host changed since, except where `derived` set its own value: desktop shell discovery
 * patches the host environment after drivers are built.
 */
export function withHostEnvironmentChanges(
  host: NodeJS.ProcessEnv,
  base: NodeJS.ProcessEnv,
  derived: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const next = { ...derived };
  for (const name of new Set([...Object.keys(base), ...Object.keys(host)])) {
    if (host[name] === base[name] || derived[name] !== base[name]) continue;
    if (host[name] === undefined) delete next[name];
    else next[name] = host[name];
  }
  return next;
}
