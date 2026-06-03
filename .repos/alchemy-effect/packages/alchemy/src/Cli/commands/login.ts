import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { Command, Flag } from "effect/unstable/cli";

import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { Profile, withProfileOverride } from "../../Auth/Profile.ts";
import { Stage } from "../../Stage.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import { Stack } from "../../Stack.ts";
import {
  envFile,
  importStack,
  instrumentCommand,
  printProfile,
  profile,
  script,
  stage,
} from "./_shared.ts";

const loginConfigure = Flag.boolean("configure").pipe(
  Flag.withDescription(
    "Run the provider's interactive configure step before logging in",
  ),
  Flag.withDefault(false),
);

export const loginCommand = Command.make(
  "login",
  {
    main: script,
    envFile,
    stage,
    profile,
    configure: loginConfigure,
  },
  instrumentCommand(
    "login",
    (a: {
      main: string;
      stage: string;
      profile: string;
      configure: boolean;
    }) => ({
      "alchemy.stage": a.stage,
      "alchemy.profile": a.profile,
      "alchemy.main": a.main,
      "alchemy.configure": a.configure,
    }),
  )(
    Effect.fnUntraced(function* ({ main, stage, envFile, profile, configure }) {
      const stackEffect = yield* importStack(main);

      const authProviders: AuthProviders["Service"] = {};

      // build the state + providers layer to capture the Auth Providers
      yield* Layer.build(
        (stackEffect.providers ?? Layer.empty).pipe(
          Layer.provideMerge(stackEffect.state ?? Layer.empty),
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(AuthProviders, authProviders),
              ConfigProvider.layer(
                withProfileOverride(
                  yield* loadConfigProvider(envFile),
                  profile,
                ),
              ),
              Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
              Layer.succeed(Stage, stage),
              Layer.succeed(Stack, {
                actions: {},
                bindings: {},
                name: stackEffect.stackName,
                resources: {},
                stage,
              }),
            ),
          ),
        ),
      );

      const profiles = yield* Profile;

      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
      const providers = Object.values(authProviders);

      if (providers.length === 0) {
        yield* Console.log(
          "No AuthProviders registered. Make sure the stack's providers() layer includes AuthProviderLayer entries.",
        );
        return;
      }

      yield* Effect.forEach(
        providers,
        (provider) =>
          Effect.gen(function* () {
            const existing = yield* profiles.getProfile(profile);
            // --configure treats every provider as missing, so configure
            // runs unconditionally and overwrites the stored entry.
            const stored = configure ? undefined : existing?.[provider.name];

            let cfg: { method: string };
            if (stored == null) {
              cfg = yield* provider.configure(profile, { ci });
              yield* profiles.setProfile(profile, {
                ...existing,
                [provider.name]: cfg,
              });
            } else {
              cfg = stored;
            }

            // `read` succeeds when creds are present and not expired
            // (refreshing OAuth proactively if near expiry). Any failure
            // — missing file, dead refresh token, etc. — falls through
            // to `login`.
            yield* provider
              .read(profile, cfg)
              .pipe(Effect.catch(() => provider.login(profile, cfg)));
          }),
        { discard: true },
      );

      // Print the resulting profile using the same renderer as
      // `alchemy profile show`.
      const final = yield* profiles.getProfile(profile);
      if (final != null) {
        yield* Console.log("");
        yield* printProfile(profile, final, authProviders);
      }
    }),
  ),
);
