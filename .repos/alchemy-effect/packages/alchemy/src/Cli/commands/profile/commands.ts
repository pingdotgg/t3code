import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { Command, Flag } from "effect/unstable/cli";
import * as Argument from "effect/unstable/cli/Argument";
import { readFileSync } from "node:fs";
import { formatElapsed } from "../../Format.ts";

import { Progress } from "../../../Alchemist/Progress.ts";
import * as Profiles from "../../../Alchemist/routes/profile.ts";
import { getEnv } from "../../../Auth/Env.ts";
import { loadConfigProvider } from "../../../Util/ConfigProvider.ts";
import * as CliKit from "../../../Cli/CliKit/index.ts";
import { resolveProfileName } from "../../../Auth/Resolve.ts";

import { exitDeclined, failWithHelp, UserInputError } from "../errors.ts";
import { config, envFile, profile, yes } from "../flags.ts";
import { instrumentCommand } from "../instrument.ts";
import {
  deleteProfileFlow,
  editProfileFlow,
  profileTui,
  renameProfileFlow,
  showProfileFlow,
} from "./flows.ts";
import { profileHub } from "./hub.ts";

const profileName = Argument.String("name").pipe(
  Argument.withDescription("Profile name"),
);

const newProfileName = Argument.String("new-name").pipe(
  Argument.withDescription("New profile name"),
  Argument.optional,
);

const refreshProviders = Flag.String("provider").pipe(
  Flag.withDescription(
    "Refresh only this connected provider (repeatable; defaults to all)",
  ),
  Flag.atLeast(0),
);

const showCommand = Command.make(
  "show",
  { profile, envFile, main: config },
  instrumentCommand("profile.show", (a: { profile: string | undefined }) => ({
    "alchemy.profile": a.profile ?? "",
  }))(
    Effect.fn(function* ({ profile, envFile, main }) {
      const activeProfile = yield* resolveProfileName(envFile, undefined);
      const profileName = profile ?? activeProfile;
      yield* showProfileFlow({
        profileName,
        activeProfile,
        envFile,
        main,
      });
    }),
  ),
).pipe(
  Command.withDescription(
    "Show connected providers, authentication status, and account details",
  ),
);

const listCommand = Command.make(
  "list",
  { envFile },
  instrumentCommand("profile.list")(
    Effect.fn(function* () {
      const entries = yield* Profiles.list();
      const cli = yield* CliKit.CliKit;
      if (cli.terminal.input) {
        const { profileListNode } = yield* profileTui;
        yield* cli.output.print(profileListNode(entries));
      } else {
        yield* Console.log(
          [
            `Profiles (${entries.length})`,
            ...entries.map((entry) => {
              const providers = entry.providers
                .map(({ name, method }) => `${name} (${method})`)
                .join(", ");
              return `${entry.active ? "*" : "-"} ${entry.name}${providers === "" ? "" : `: ${providers}`}`;
            }),
          ].join("\n"),
        );
      }
    }),
  ),
).pipe(Command.withDescription("List profiles and their connected providers"));

const createCommand = Command.make(
  "create",
  { name: profileName },
  instrumentCommand("profile.create", (a: { name: string }) => ({
    "alchemy.profile": a.name,
  }))(
    Effect.fn(function* ({ name }) {
      yield* Profiles.create({ name });
      yield* CliKit.accessors.output.success(
        `Created profile '${name}'. Run \`alchemy profile edit --profile ${name}\` to connect accounts.`,
      );
    }),
  ),
).pipe(Command.withDescription("Create an empty authentication profile"));

const renameCommand = Command.make(
  "rename",
  { name: profileName, newName: newProfileName },
  instrumentCommand(
    "profile.rename",
    (a: { name: string; newName: Option.Option<string> }) => ({
      "alchemy.profile": a.name,
      "alchemy.profile.new_name": Option.getOrUndefined(a.newName) ?? "",
    }),
  )(
    Effect.fn(function* ({ name, newName }) {
      if (Option.isSome(newName)) {
        yield* Profiles.rename({
          name,
          newName: newName.value.trim(),
        });
        yield* CliKit.accessors.output.success(
          `Renamed profile '${name}' to '${newName.value.trim()}'.`,
        );
        return;
      }
      yield* renameProfileFlow(name, undefined);
    }),
  ),
).pipe(
  Command.withDescription(
    "Rename a profile and move all credentials stored for it",
  ),
);

const addProviders = Flag.String("add").pipe(
  Flag.withDescription("Connect a provider to the profile (repeatable)"),
  Flag.atLeast(0),
);

const reconfigureProviders = Flag.String("reconfigure").pipe(
  Flag.withDescription(
    "Re-run a connected provider's configuration (repeatable)",
  ),
  Flag.atLeast(0),
);

const removeProviders = Flag.String("remove").pipe(
  Flag.withDescription(
    "Log out a connected provider and disconnect it (repeatable)",
  ),
  Flag.atLeast(0),
);

const methodFlag = Flag.String("method").pipe(
  Flag.withDescription(
    "Configure non-interactively using this method (each provider documents its methods and fields in `alchemy profile edit --help`)",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const setFlag = Flag.String("set").pipe(
  Flag.withDescription(
    "Field for non-interactive configure: name=value, name=env:VAR, or name=- to read the value from stdin (repeatable)",
  ),
  Flag.atLeast(0),
);

/**
 * Resolve `--set` entries into concrete values. Three forms keep secrets
 * out of shell history: a literal, `env:VAR` (read from the environment /
 * --env-file), and `-` (read from stdin; at most one field may use it).
 */
const resolveSetValues = Effect.fn(function* (
  sets: ReadonlyArray<string>,
  envFile: Option.Option<string>,
) {
  const values: Record<string, string> = {};
  let stdinUsed = false;
  const configProvider = yield* loadConfigProvider(envFile);
  for (const entry of sets) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      return yield* Effect.fail(
        new UserInputError({
          message: `Invalid --set '${entry}'. Expected name=value, name=env:VAR, or name=-.`,
        }),
      );
    }
    const key = entry.slice(0, separator);
    const raw = entry.slice(separator + 1);
    if (key in values) {
      return yield* Effect.fail(
        new UserInputError({ message: `Duplicate --set for '${key}'.` }),
      );
    }
    if (raw === "-") {
      if (stdinUsed) {
        return yield* Effect.fail(
          new UserInputError({
            message: "Only one --set field may read from stdin.",
          }),
        );
      }
      if (process.stdin.isTTY) {
        return yield* Effect.fail(
          new UserInputError({
            message: `--set ${key}=- reads from stdin, but stdin is a terminal. Pipe the value in.`,
          }),
        );
      }
      stdinUsed = true;
      // Reading fd 0 to EOF is inherently synchronous whole-input
      // consumption; there is no FileSystem-service surface for stdin.
      values[key] = yield* Effect.try({
        try: () => readFileSync(0, "utf8").trim(),
        catch: (cause) =>
          new UserInputError({
            message: `Could not read stdin for --set ${key}=-: ${cause}`,
          }),
      });
    } else if (raw.startsWith("env:")) {
      const variable = raw.slice(4);
      const value = yield* getEnv(variable).pipe(
        Effect.provide(ConfigProvider.layer(configProvider)),
        Effect.mapError((e) => new UserInputError({ message: e.message })),
      );
      if (value === undefined || value.length === 0) {
        return yield* Effect.fail(
          new UserInputError({
            message: `--set ${key}=env:${variable}: '${variable}' is not set.`,
          }),
        );
      }
      values[key] = value;
    } else {
      values[key] = raw;
    }
  }
  return values;
});

const editCommand = Command.make(
  "edit",
  {
    profile,
    add: addProviders,
    reconfigure: reconfigureProviders,
    remove: removeProviders,
    method: methodFlag,
    set: setFlag,
    envFile,
    main: config,
  },
  instrumentCommand(
    "profile.edit",
    (a: {
      profile: string | undefined;
      add: ReadonlyArray<string>;
      reconfigure: ReadonlyArray<string>;
      remove: ReadonlyArray<string>;
    }) => ({
      "alchemy.profile": a.profile ?? "",
      "alchemy.add": a.add.join(","),
      "alchemy.re_configure": a.reconfigure.join(","),
      "alchemy.remove": a.remove.join(","),
    }),
  )(
    Effect.fn(function* ({
      profile,
      add,
      reconfigure,
      remove,
      method,
      set,
      envFile,
      main,
    }) {
      const selectedProfile = yield* resolveProfileName(envFile, profile);
      let configureInput:
        | { method?: string; values: Record<string, string> }
        | undefined;
      if (method !== undefined || set.length > 0) {
        if (add.length + reconfigure.length !== 1 || remove.length > 0) {
          return yield* Effect.fail(
            new UserInputError({
              message:
                "--method/--set configure exactly one provider: pass a single --add or --reconfigure (and no --remove).",
            }),
          );
        }
        configureInput = {
          method,
          values: yield* resolveSetValues(set, envFile),
        };
      }
      if (configureInput !== undefined) {
        const provider = (add[0] ?? reconfigure[0])!;
        yield* Profiles.configure({
          profile: selectedProfile,
          provider,
          entrypoint: main,
          envFile: Option.getOrUndefined(envFile),
          action: add.length === 1 ? "add" : "reconfigure",
          method: configureInput.method ?? "",
          values: Object.fromEntries(
            Object.entries(configureInput.values).map(([key, value]) => [
              key,
              Redacted.make(value),
            ]),
          ),
        });
        yield* CliKit.accessors.output.success(
          `${add.length === 1 ? "Added" : "Updated"} '${provider}' in profile '${selectedProfile}'.`,
        );
        return;
      }
      if (add.length === 0 && reconfigure.length === 0 && remove.length > 0) {
        for (const provider of remove) {
          yield* Profiles.removeProvider({
            profile: selectedProfile,
            provider,
            entrypoint: main,
            envFile: Option.getOrUndefined(envFile),
          });
          yield* CliKit.accessors.output.success(
            `Removed '${provider}' from profile '${selectedProfile}'.`,
          );
        }
        return;
      }
      yield* editProfileFlow({
        selectedProfile,
        add,
        reconfigure,
        remove,
        envFile,
        main,
        configureInput,
      });
    }),
  ),
).pipe(
  Command.withDescription(
    "Add, reconfigure, or remove provider accounts in a profile",
  ),
);

const refreshCommand = Command.make(
  "refresh",
  {
    profile,
    providers: refreshProviders,
    envFile,
    main: config,
  },
  instrumentCommand(
    "profile.refresh",
    (a: { profile: string | undefined; providers: ReadonlyArray<string> }) => ({
      "alchemy.profile": a.profile ?? "",
      "alchemy.providers": a.providers.join(","),
    }),
  )(
    Effect.fn(function* ({ profile, providers, envFile, main }) {
      const selectedProfile = yield* resolveProfileName(envFile, profile);
      const refreshStarted = new Map<string, number>();
      yield* Profiles.refresh({
        profile: selectedProfile,
        providers,
        entrypoint: main,
        envFile: Option.getOrUndefined(envFile),
      }).pipe(
        Effect.provideService(Progress, (event) =>
          event._tag === "provider.refresh.started"
            ? Clock.currentTimeMillis.pipe(
                Effect.tap((now) =>
                  Effect.sync(() => refreshStarted.set(event.provider, now)),
                ),
                Effect.andThen(
                  CliKit.accessors.output.info(`Refreshing ${event.provider}`),
                ),
              )
            : event._tag === "provider.refresh.completed"
              ? Clock.currentTimeMillis.pipe(
                  Effect.flatMap((now) => {
                    const from = refreshStarted.get(event.provider);
                    return CliKit.accessors.output.success(
                      `Refreshed ${event.provider}${from === undefined ? "" : ` (${formatElapsed(now - from)})`}`,
                    );
                  }),
                )
              : Effect.void,
        ),
      );
      yield* CliKit.accessors.output.success(
        `Refreshed profile '${selectedProfile}'.`,
      );
    }),
  ),
).pipe(
  Command.withDescription(
    "Refresh credentials for connected providers without reconfiguring them",
  ),
);

const currentCommand = Command.make(
  "current",
  { envFile },
  instrumentCommand("profile.current")(
    Effect.fn(function* () {
      const selected = yield* Profiles.current();
      const source =
        selected.source === "configuration"
          ? "ALCHEMY_PROFILE"
          : selected.source === "default"
            ? "built-in default"
            : "command line";
      const cli = yield* CliKit.CliKit;
      if (cli.terminal.input) {
        const { currentProfileNode } = yield* profileTui;
        yield* cli.output.print(currentProfileNode(selected.name, source));
      } else {
        yield* Console.log(`${selected.name} (${source})`);
      }
    }),
  ),
).pipe(
  Command.withDescription("Show the effective profile and how it was selected"),
);

const deleteCommand = Command.make(
  "delete",
  { name: profileName, envFile, main: config, yes },
  instrumentCommand("profile.delete", (a: { name: string; yes: boolean }) => ({
    "alchemy.profile": a.name,
    "alchemy.yes": a.yes,
  }))(
    Effect.fn(function* ({ name, envFile, main, yes }) {
      const deleted = yield* deleteProfileFlow({ name, envFile, main, yes });
      // Declined or nothing-to-delete: exit non-zero so scripts don't read
      // the run as "profile removed". (The dashboard confirms in its own UI
      // and calls the shared delete core, so it is unaffected.)
      if (!deleted) yield* exitDeclined;
    }),
  ),
).pipe(
  Command.withDescription("Delete a profile and all credentials stored for it"),
);

export const profileCommand = Command.make(
  "profile",
  { envFile, main: config },
  instrumentCommand("profile")(
    Effect.fn(function* ({ envFile, main }) {
      if (!(yield* CliKit.CliKit).terminal.input) {
        // No terminal to drive the hub — show the subcommand help instead,
        // which documents the flag-driven equivalents of every hub action.
        return yield* failWithHelp(["alchemy", "profile"]);
      }
      yield* profileHub({ envFile, main });
    }),
  ),
).pipe(
  Command.withDescription("Manage authentication profiles and accounts"),
  Command.withSubcommands([
    createCommand,
    renameCommand,
    editCommand,
    refreshCommand,
    listCommand,
    showCommand,
    currentCommand,
    deleteCommand,
  ]),
);
