import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import { stripAppImageRuntimeEnv } from "@t3tools/shared/appImageRuntimeEnv";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { providerProcessEnvironment } from "./providerTelemetry.ts";
import { expandHomeVariable } from "./pathExpansion.ts";
import * as ProviderHost from "./ProviderHost.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  // Commands the agent runs inherit this env; the AppImage mount's libraries would shadow the system's.
  const hostEnv = stripAppImageRuntimeEnv(baseEnv);
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const windows = platform === "win32";
  const next: NodeJS.ProcessEnv = environment?.length ? { ...hostEnv } : hostEnv;
  for (const variable of environment ?? []) {
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
  const host = yield* Effect.serviceOption(ProviderHost.ProviderHost);
  const prepared =
    Option.isSome(host) && host.value.prepareAgentEnvironment !== undefined
      ? yield* host.value.prepareAgentEnvironment(next)
      : next;
  return providerProcessEnvironment(prepared, platform);
});
