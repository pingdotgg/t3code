import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { BuildProvider } from "./Build.ts";
import { CommandExecutorLive } from "./Command.ts";
import { DevProvider } from "./Dev.ts";
import { ExecProvider } from "./Exec.ts";

export const providers = () =>
  Layer.mergeAll(
    BuildProvider(),
    DevProvider(),
    ExecProvider(),
    // TODO: Remove before v2.0.0 stable release.
    Renamed({ from: "Build.Command", to: "Command.Build" }),
    Renamed({ from: "Build.DevServer", to: "Command.Dev" }),
  ).pipe(Layer.provide(CommandExecutorLive()));

/**
 * Constructs a no-op provider for a resource that has been renamed.
 * This prevents errors when attempting to tear down the old resource.
 * The type is Layer.Layer<never> to avoid polluting the type signature.
 */
const Renamed = (input: { from: string; to: string }) => {
  const message = (id: string) =>
    `The "${input.from}" resource has been renamed to "${input.to}". Please update "${id}" to use the new resource.`;

  return Provider.succeed(Resource(input.from), {
    // The only one of these methods that would be called normally is `delete`, if you have an old version in state that needs to be removed.
    // The other methods are defensive to prevent undefined behavior.
    // You'll only end up calling these if you're using a `Build` resource manually;
    // if you're using a `StaticSite` resource, the Alchemy engine migrates the old resource automatically.
    diff: ({ id }) =>
      Effect.logWarning(message(id)).pipe(Effect.as({ action: "noop" })),
    precreate: ({ id }) => Effect.die(message(id)),
    reconcile: ({ id }) => Effect.die(message(id)),
    delete: () => Effect.void,
    list: () => Effect.succeed([]),
  }) as Layer.Layer<never>;
};
