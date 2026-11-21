import type { ProviderInstanceEnvironment } from "@lathe/contracts";
import * as HostProcess from "@lathe/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomeVariable } from "./pathExpansion.ts";

/**
 * A view of `base` with `overrides` on top; an `undefined` override hides the inherited name.
 * Desktop shell discovery patches process.env after drivers start, so the view must not copy it.
 */
export function overlayEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const local = { ...overrides };
  const read = (key: string) => (Object.hasOwn(local, key) ? local[key] : base[key]);
  return new Proxy<NodeJS.ProcessEnv>(
    {},
    {
      get: (_, key) => (typeof key === "string" ? read(key) : undefined),
      has: (_, key) => typeof key === "string" && read(key) !== undefined,
      set: (_, key, value) => {
        if (typeof key === "string") local[key] = value === undefined ? undefined : String(value);
        return true;
      },
      deleteProperty: (_, key) => {
        if (typeof key === "string") local[key] = undefined;
        return true;
      },
      ownKeys: () =>
        [...new Set([...Object.keys(base), ...Object.keys(local)])].filter(
          (key) => read(key) !== undefined,
        ),
      getOwnPropertyDescriptor: (_, key) => {
        const value = typeof key === "string" ? read(key) : undefined;
        return value === undefined
          ? undefined
          : { value, writable: true, enumerable: true, configurable: true };
      },
    },
  );
}

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const windows = (yield* HostProcess.Platform) === "win32";
  const overrides: Record<string, string | undefined> = {};
  for (const variable of environment) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    // Windows reads names without regard to case, and a child gets the first spelling in sort
    // order. Upper case sorts first, so the configured value wins even where a spawn merges the
    // parent environment back in.
    const name = windows ? variable.name.toUpperCase() : variable.name;
    if (windows) {
      for (const inherited of Object.keys(baseEnv)) {
        if (inherited.toUpperCase() === name) overrides[inherited] = undefined;
      }
    }
    overrides[name] = expandHomeVariable(name, variable.value, home);
  }
  return overlayEnvironment(baseEnv, overrides);
});
