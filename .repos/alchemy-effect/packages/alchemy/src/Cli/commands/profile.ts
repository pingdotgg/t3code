import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "effect/unstable/cli";
import * as Argument from "effect/unstable/cli/Argument";

import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { CredentialsStore } from "../../Auth/Credentials.ts";
import { AlchemyProfile } from "../../Auth/Profile.ts";

import {
  buildBuiltinAuthProviders,
  buildStackProviders,
  envFile,
  instrumentCommand,
  printProfile,
  profile,
} from "./_shared.ts";

/**
 * Entrypoint whose `providers()` layer contributes the user's own auth
 * providers. Optional and best-effort — if it's missing or fails to load,
 * `profile show` still renders the built-in providers.
 */
const mainFile = Argument.file("main").pipe(
  Argument.withDescription(
    "Stack entrypoint whose providers() should be used, defaults to alchemy.run.ts",
  ),
  Argument.withDefault("alchemy.run.ts"),
);

/**
 * Populate an {@link AuthProviders} registry for display: the built-in
 * providers first, then the user's stack `providers()` layer on top so a
 * customized provider (same name) overrides the built-in one. Loading the
 * user's stack is best-effort — a missing or invalid entrypoint leaves the
 * built-ins in place.
 *
 * Registration happens as a side effect of building each layer (see
 * `AuthProviderLayer`), and later builds overwrite earlier entries by name,
 * so build order is what gives the user's providers precedence.
 */
export const collectAuthProviders = Effect.fn("collectAuthProviders")(
  function* (options: {
    main: string;
    envFile: Option.Option<string>;
    profile: string;
  }) {
    const authProviders: AuthProviders["Service"] = {};

    // 1. Built-in providers first (baseline).
    yield* buildBuiltinAuthProviders({
      envFile: options.envFile,
      profile: options.profile,
      registry: authProviders,
    });

    // 2. The user's own providers() layer on top — building into the same
    //    registry overrides the built-ins by name. Best-effort: swallow
    //    load/build failures (including a missing entrypoint) so display
    //    still works with just the built-ins.
    yield* buildStackProviders({ ...options, registry: authProviders }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("profile show: could not load user stack providers", {
          cause,
        }),
      ),
    );

    return authProviders;
  },
);

const showCommand = Command.make(
  "show",
  { profile, envFile, main: mainFile },
  instrumentCommand("profile.show", (a: { profile: string }) => ({
    "alchemy.profile": a.profile,
  }))(
    Effect.fn(function* ({ profile, envFile, main }) {
      const profiles = yield* AlchemyProfile;
      const stored = yield* profiles.getProfile(profile);
      if (stored == null) {
        const config = yield* profiles.readConfig;
        const names = Object.keys(config.profiles);
        yield* Console.log(`Profile '${profile}' not found.`);
        if (names.length > 0) {
          yield* Console.log(`Available profiles: ${names.sort().join(", ")}`);
        } else {
          yield* Console.log("No profiles configured. Run `alchemy login`.");
        }
        return;
      }

      const authProviders = yield* collectAuthProviders({
        main,
        envFile,
        profile,
      });

      yield* printProfile(profile, stored, authProviders);
    }),
  ),
);

const clearCommand = Command.make(
  "clear",
  { profile },
  instrumentCommand("profile.clear", (a: { profile: string }) => ({
    "alchemy.profile": a.profile,
  }))(
    Effect.fn(function* ({ profile }) {
      const profiles = yield* AlchemyProfile;
      const store = yield* CredentialsStore;
      const removed = yield* profiles.deleteProfile(profile);
      yield* store.deleteProfile(profile);
      if (removed) {
        yield* Console.log(
          `Cleared profile '${profile}' and all its credentials.`,
        );
      } else {
        yield* Console.log(
          `Profile '${profile}' not found in profiles.json; removed any stray credentials directory.`,
        );
      }
    }),
  ),
);

export const profileCommand = Command.make("profile", {}).pipe(
  Command.withSubcommands([showCommand, clearCommand]),
);
