import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Profiles from "../../../Alchemist/routes/profile.ts";
import * as CliKit from "../../../Cli/CliKit/index.ts";
import { confirmOrDecline } from "../confirm.ts";
import { isPromptCancellation } from "../errors.ts";

export const profileTui = Effect.promise(
  () => import("../../../Cli/components/view/Profile.tsx"),
);

export type EditAction = "add" | "reconfigure" | "remove";
export interface EditOutcome {
  readonly provider: string;
  readonly action: EditAction;
  readonly outcome: "done" | "skipped";
}

export const showProfileFlow = Effect.fn(function* (options: {
  profileName: string;
  activeProfile: string;
  envFile: Option.Option<string>;
  main: string;
}) {
  const profile = yield* Profiles.get({
    name: options.profileName,
    includeProviderStatus: true,
    entrypoint: options.main,
    envFile: Option.getOrUndefined(options.envFile),
  });
  yield* Console.log(
    [
      `${profile.active ? "*" : "-"} ${profile.name}`,
      ...profile.providers.map((provider) =>
        [
          `  ${provider.name} (${provider.method}) — ${provider.status}`,
          ...provider.details.map(({ key, value }) => `    ${key}: ${value}`),
          ...(provider.diagnostic
            ? [`    ${provider.diagnostic.message}`]
            : []),
        ].join("\n"),
      ),
    ].join("\n"),
  );
});

export const renameProfileFlow = Effect.fn(function* (
  name: string,
  suppliedNewName: string | undefined,
) {
  const newName = (
    suppliedNewName ??
    (yield* CliKit.accessors.prompt.text({
      message: `Rename profile '${name}' to`,
      placeholder: `${name}-new`,
      validate: (value) =>
        value.trim().length > 0 ? undefined : "Profile name is required",
    }))
  ).trim();
  yield* Profiles.rename({ name, newName });
  yield* CliKit.accessors.output.success(
    `Renamed profile '${name}' to '${newName}'.`,
  );
  return newName;
});

export const deleteProfileFlow = Effect.fn(function* (options: {
  name: string;
  envFile: Option.Option<string>;
  main: string;
  yes: boolean;
}) {
  // Existence check only — skip the provider-status probe (it imports the
  // stack entrypoint and reaches provider APIs).
  const exists = yield* Profiles.get({
    name: options.name,
    includeProviderStatus: false,
  }).pipe(Effect.option);
  if (Option.isNone(exists)) {
    yield* Console.log(
      `Profile ${options.name}: Not found. Nothing was deleted.`,
    );
    return false;
  }
  // Declining short-circuits with exit code 1; the boolean only reports the
  // not-found early return above to the caller.
  yield* confirmOrDecline({
    yes: options.yes,
    message: `Delete profile '${options.name}' and all its stored credentials? This cannot be undone.`,
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
  });
  yield* Profiles.deleteProfile({ name: options.name });
  yield* CliKit.accessors.output.success(
    `Deleted profile '${options.name}' and its credentials.`,
  );
  return true;
});

export const editProfileFlow = Effect.fn(function* (options: {
  selectedProfile: string;
  add: ReadonlyArray<string>;
  reconfigure: ReadonlyArray<string>;
  remove: ReadonlyArray<string>;
  envFile: Option.Option<string>;
  main: string;
  configureInput?: {
    method?: string;
    values: Record<string, string>;
  };
}) {
  let plan: Array<{ provider: string; action: EditAction }> = [
    ...options.add.map((provider) => ({ provider, action: "add" as const })),
    ...options.reconfigure.map((provider) => ({
      provider,
      action: "reconfigure" as const,
    })),
    ...options.remove.map((provider) => ({
      provider,
      action: "remove" as const,
    })),
  ];

  if (plan.length === 0) {
    // Only connected names/methods are needed for the cycle prompt; the
    // status probe would import the entrypoint and reach provider APIs.
    const profile = yield* Profiles.get({
      name: options.selectedProfile,
      includeProviderStatus: false,
    });
    const available = yield* Profiles.providers({
      profile: options.selectedProfile,
      entrypoint: options.main,
      envFile: Option.getOrUndefined(options.envFile),
    });
    const connected = new Map(
      profile.providers.map((item) => [item.name, item]),
    );
    const names = [
      ...new Set([...connected.keys(), ...available.map(({ name }) => name)]),
    ].sort();
    const prompt = yield* CliKit.CliKit;
    const { editStateStyle } = yield* profileTui;
    const glyphs = CliKit.glyphsFor(prompt.terminal.unicode);
    const state = (
      key: keyof typeof editStateStyle,
      value: { provider: string; action: EditAction } | null,
    ) => ({
      value,
      icon: glyphs[editStateStyle[key].icon],
      label: editStateStyle[key].label,
      variant: editStateStyle[key].variant,
    });
    const choices = names.map((provider) =>
      connected.has(provider)
        ? {
            label: provider,
            description: connected.get(provider)!.method,
            states: [
              state("keep", null),
              state("reconfigure", { provider, action: "reconfigure" }),
              state("remove", { provider, action: "remove" }),
            ],
          }
        : {
            label: provider,
            states: [
              state("skip", null),
              state("add", { provider, action: "add" }),
            ],
          },
    );
    plan = (yield* prompt.prompt.cycle({
      message: `Manage accounts in profile '${options.selectedProfile}'`,
      options: choices,
      requireChange: true,
    })).filter((item) => item !== null);
  }

  const outcomes: EditOutcome[] = [];
  for (const step of plan) {
    const run =
      step.action === "remove"
        ? Profiles.removeProvider({
            profile: options.selectedProfile,
            provider: step.provider,
            entrypoint: options.main,
            envFile: Option.getOrUndefined(options.envFile),
          })
        : Profiles.configure({
            profile: options.selectedProfile,
            provider: step.provider,
            entrypoint: options.main,
            envFile: Option.getOrUndefined(options.envFile),
            action: step.action,
            method: options.configureInput?.method,
            values:
              options.configureInput === undefined
                ? undefined
                : Object.fromEntries(
                    Object.entries(options.configureInput.values).map(
                      ([key, value]) => [key, Redacted.make(value)],
                    ),
                  ),
          }).pipe(Effect.asVoid);
    const result = yield* Effect.result(run);
    if (result._tag === "Success") {
      outcomes.push({ ...step, outcome: "done" });
    } else if (isPromptCancellation(result.failure)) {
      outcomes.push({ ...step, outcome: "skipped" });
    } else {
      return yield* Effect.fail(result.failure);
    }
  }
  return outcomes;
});
