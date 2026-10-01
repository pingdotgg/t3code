/**
 * The dev sidecar entry: ONE process hosting every RPC-backed local
 * provider — Cloudflare's workerd-backed providers, the floci-backed AWS
 * providers, `Command.Dev` processes, framework dev servers — so their
 * long-lived state survives exec-child hot reloads during `alchemy dev`.
 *
 * Providers arrive in groups: each `RpcProvider.effect` names the URL of a
 * module whose default export is its group's provider layer (see
 * `Cloudflare/Local.ts`, `AWS/Local/Local.ts`, `Command/Local.ts`,
 * `Website/ServerLocal.ts`). A group is imported and built the first time
 * a session asks for one of its types, so a Cloudflare-only stack never
 * loads the AWS providers or starts the emulator they need. The spawner
 * (`RpcSpawner`) forks this entry once per run; `RpcProviderProxy` points
 * every provider at it.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcServer from "./RpcServer.ts";

RpcServer.launch((group) =>
  Effect.promise(() => import(group)).pipe(
    Effect.flatMap((module: { default?: unknown }) =>
      Layer.isLayer(module.default)
        ? Effect.succeed(module.default as RpcServer.ProviderLayer)
        : Effect.fail(
            new Error(
              `Provider group module ${group} must default-export its provider Layer`,
            ),
          ),
    ),
  ),
);
