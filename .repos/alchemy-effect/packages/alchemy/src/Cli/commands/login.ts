import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import * as Argument from "effect/unstable/cli/Argument";
import * as CliError from "effect/unstable/cli/CliError";

import type { AuthProviders } from "../../Auth/AuthProvider.ts";
import { AlchemyProfile } from "../../Auth/Profile.ts";
import * as Clank from "../../Util/Clank.ts";

import {
  buildBuiltinAuthProviders,
  buildStackProviders,
  envFile,
  instrumentCommand,
  printProfile,
  profile,
} from "./_shared.ts";

const loginConfigure = Flag.boolean("configure").pipe(
  Flag.withDescription(
    "Run the provider's interactive configure step before logging in",
  ),
  Flag.withDefault(false),
);

/**
 * Stack entrypoint whose `providers()` layer selects which auth providers
 * to log in with. Optional: when omitted and no `alchemy.run.ts` exists in
 * the current folder, `alchemy login` falls back to every built-in auth
 * provider, so logging in (and refreshing credentials) works from any
 * folder.
 */
const loginMain = Argument.file("main").pipe(
  Argument.withDescription(
    "Stack entrypoint whose providers() to log in with, defaults to alchemy.run.ts (falls back to all built-in providers when absent)",
  ),
  Argument.optional,
);

export const loginCommand = Command.make(
  "login",
  {
    main: loginMain,
    envFile,
    profile,
    configure: loginConfigure,
  },
  instrumentCommand(
    "login",
    (a: {
      main: Option.Option<string>;
      profile: string;
      configure: boolean;
    }) => ({
      "alchemy.profile": a.profile,
      "alchemy.main": Option.getOrElse(a.main, () => "alchemy.run.ts"),
      "alchemy.configure": a.configure,
    }),
  )(
    Effect.fn(function* ({ main, envFile, profile, configure }) {
      const fs = yield* FileSystem.FileSystem;
      const explicitMain = Option.getOrUndefined(main);
      const mainPath = explicitMain ?? "alchemy.run.ts";
      const mainExists = yield* fs
        .exists(mainPath)
        .pipe(Effect.catch(() => Effect.succeed(false)));

      // An explicitly-passed entrypoint must exist; only the default may
      // fall back to the built-in providers.
      if (explicitMain != null && !mainExists) {
        return yield* Effect.fail(
          new CliError.InvalidValue({
            option: "main",
            value: explicitMain,
            expected: "an existing stack entrypoint file",
            kind: "argument",
          }),
        );
      }

      const profiles = yield* AlchemyProfile;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

      let authProviders: AuthProviders["Service"];
      // Providers to actually log in with; `undefined` means all registered.
      let selected: string[] | undefined;
      if (mainExists) {
        // Build the user's providers() (+ state) layer to capture the auth
        // providers their stack wires up.
        ({ authProviders } = yield* buildStackProviders({
          main: mainPath,
          envFile,
          profile,
        }));
      } else {
        // No stack entrypoint — register every built-in auth provider so
        // `alchemy login` works from any folder. Interactively, let the
        // user pick which ones to log in with; in CI, take them all.
        yield* Console.log(
          "No alchemy.run.ts found — using Alchemy's built-in providers.",
        );
        authProviders = yield* buildBuiltinAuthProviders({ envFile, profile });
        if (!ci) {
          const existing = yield* profiles.getProfile(profile);
          const names = Object.keys(authProviders).sort();
          selected = yield* Clank.multiselect({
            message: "Select providers to log in with",
            options: names.map((name) => ({
              value: name,
              label: name,
              hint: existing?.[name] != null ? "configured" : undefined,
            })),
            // Pre-select providers already in the profile so re-running
            // login naturally refreshes/re-prints what's set up.
            initialValues: names.filter((name) => existing?.[name] != null),
          });
        }
      }

      const providers = Object.values(authProviders).filter(
        (provider) => selected == null || selected.includes(provider.name),
      );

      if (providers.length === 0) {
        yield* Console.log(
          selected != null
            ? "No providers selected."
            : "No AuthProviders registered. Make sure the stack's providers() layer includes AuthProviderLayer entries.",
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
