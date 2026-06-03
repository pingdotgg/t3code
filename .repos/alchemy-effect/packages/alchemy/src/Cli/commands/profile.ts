import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { Command } from "effect/unstable/cli";

import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { CredentialsStore } from "../../Auth/Credentials.ts";
import { Profile, withProfileOverride } from "../../Auth/Profile.ts";
import { AwsAuth } from "../../AWS/AuthProvider.ts";
import { AxiomAuth } from "../../Axiom/AuthProvider.ts";
import { CloudflareAuth } from "../../Cloudflare/Auth/AuthProvider.ts";
import { GitHubAuth } from "../../GitHub/AuthProvider.ts";
import { NeonAuth } from "../../Neon/AuthProvider.ts";
import { PlanetscaleAuth } from "../../Planetscale/AuthProvider.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import {
  envFile,
  instrumentCommand,
  printProfile,
  profile,
} from "./_shared.ts";

const showCommand = Command.make(
  "show",
  { profile, envFile },
  instrumentCommand("profile.show", (a: { profile: string }) => ({
    "alchemy.profile": a.profile,
  }))(
    Effect.fnUntraced(function* ({ profile, envFile }) {
      const profiles = yield* Profile;
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

      const authProviders: AuthProviders["Service"] = {};
      const authRegistry = Layer.succeed(AuthProviders, authProviders);
      const services = Layer.mergeAll(
        authRegistry,
        ConfigProvider.layer(
          withProfileOverride(yield* loadConfigProvider(envFile), profile),
        ),
        Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
        // Building these layers triggers their AuthProviderLayer effect, which
        // registers the provider into the shared `authProviders` registry.
        Layer.provide(
          Layer.mergeAll(
            AwsAuth,
            AxiomAuth,
            CloudflareAuth,
            GitHubAuth,
            NeonAuth,
            PlanetscaleAuth,
          ),
          authRegistry,
        ),
      );

      yield* printProfile(profile, stored, authProviders).pipe(
        Effect.provide(services),
      );
    }),
  ),
);

const clearCommand = Command.make(
  "clear",
  { profile },
  instrumentCommand("profile.clear", (a: { profile: string }) => ({
    "alchemy.profile": a.profile,
  }))(
    Effect.fnUntraced(function* ({ profile }) {
      const profiles = yield* Profile;
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
