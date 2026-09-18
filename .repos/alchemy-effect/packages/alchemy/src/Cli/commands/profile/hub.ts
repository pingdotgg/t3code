import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { Progress } from "../../../Alchemist/Progress.ts";
import * as Profiles from "../../../Alchemist/routes/profile.ts";
import { importStack } from "../../../Alchemist/Session.ts";
import { DEFAULT_PROFILE_NAME } from "../../../Auth/Profile.ts";
import { CliKit } from "../../CliKit/index.ts";
import { isPromptCancellation } from "../errors.ts";

export const profileHub = Effect.fn(function* (options: {
  envFile: Option.Option<string>;
  main: string;
}) {
  const envFile = Option.getOrUndefined(options.envFile);
  const computeEntries = Profiles.list().pipe(
    Effect.map((profiles) =>
      profiles.map((profile) => ({
        name: profile.name,
        isActive: profile.active,
        isDefault: profile.name === DEFAULT_PROFILE_NAME,
      })),
    ),
  );
  const initialEntries = yield* computeEntries;
  // The dashboard falls back to the last good listing when a reload fails.
  const lastEntries = yield* Ref.make(initialEntries);
  const refreshEntries = computeEntries.pipe(
    Effect.tap((entries) => Ref.set(lastEntries, entries)),
  );
  const { runProfileDashboardSession } = yield* Effect.promise(
    () => import("../../components/view/ProfileDashboard.tsx"),
  );
  // Warm the entrypoint module cache before the dashboard mounts: the user's
  // stack module evaluates synchronously on the main thread and would freeze
  // the credential spinner mid-frame. Like deploy's planning session, show a
  // static (non-spinning) row that makes no motion promise. Failures are
  // ignored here — `loadDetails` re-imports from the cache and surfaces them.
  const cli = yield* CliKit;
  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* cli.live.progress({
        label: "Importing stack module",
        spinning: false,
      });
      // let the row paint before synchronous module evaluation starts
      yield* Effect.sleep("1 millis");
      yield* importStack(options.main).pipe(Effect.ignore);
    }),
  );

  yield* runProfileDashboardSession({
    entries: initialEntries,
    selected: initialEntries.find(({ isActive }) => isActive)?.name,
    loadDetails: (name) =>
      Effect.gen(function* () {
        const [profile, providers] = yield* Effect.all([
          Profiles.get({
            name,
            includeProviderStatus: true,
            entrypoint: options.main,
            envFile,
          }),
          Profiles.providers({
            profile: name,
            entrypoint: options.main,
            envFile,
          }),
        ]);
        return {
          providers: profile.providers.map((provider) => ({
            name: provider.name,
            method: provider.method,
            status:
              provider.status === "connected"
                ? ("configured" as const)
                : provider.status === "needs-reauth"
                  ? ("reauth" as const)
                  : provider.status === "needs-reconfigure"
                    ? ("reconfigure" as const)
                    : ("error" as const),
            lines: [
              ...provider.details.map(({ key, value }) => `${key}: ${value}`),
              ...(provider.diagnostic ? [provider.diagnostic.message] : []),
            ],
          })),
          available: providers
            .filter(({ connected }) => !connected)
            .map(({ name }) => name),
        };
      }),
    execute: (action) =>
      Effect.gen(function* () {
        let selected: string | undefined;
        let message: string;
        if (action.kind === "create") {
          yield* Profiles.create({ name: action.name });
          selected = action.name;
          message = `Created profile '${action.name}'.`;
        } else if (action.kind === "rename") {
          yield* Profiles.rename({
            name: action.name,
            newName: action.newName,
          });
          selected = action.newName;
          message = `Renamed '${action.name}' to '${action.newName}'.`;
        } else {
          yield* Profiles.deleteProfile({ name: action.name });
          message = `Deleted '${action.name}' and its credentials.`;
        }
        const entries = yield* refreshEntries;
        return { ok: true, message, entries, selected };
      }).pipe(
        Effect.catch((error) =>
          Effect.map(Ref.get(lastEntries), (entries) => ({
            ok: false,
            message: error.message,
            entries,
          })),
        ),
      ),
    runFlow: (action, events) =>
      Effect.gen(function* () {
        if (action.kind === "refresh") {
          yield* Profiles.refresh({
            profile: action.name,
            providers:
              action.provider === undefined ? undefined : [action.provider],
            entrypoint: options.main,
            envFile,
          }).pipe(
            Effect.provideService(Progress, (event) =>
              event._tag === "provider.refresh.started"
                ? events.onProviderStart(event.provider)
                : Effect.void,
            ),
          );
          return {
            ok: true,
            message:
              action.provider === undefined
                ? "Credentials refreshed."
                : `${action.provider} credentials refreshed.`,
          };
        }

        const outcomes: string[] = [];
        for (const provider of action.remove) {
          yield* Profiles.removeProvider({
            profile: action.name,
            provider,
            entrypoint: options.main,
            envFile,
          });
          outcomes.push(`${provider} removed`);
        }
        for (const [kind, names] of [
          ["add", action.add],
          ["reconfigure", action.reconfigure],
        ] as const) {
          for (const provider of names) {
            yield* Profiles.configure({
              profile: action.name,
              provider,
              entrypoint: options.main,
              envFile,
              action: kind,
            });
            outcomes.push(
              `${provider} ${kind === "add" ? "added" : "updated"}`,
            );
          }
        }
        return {
          ok: true,
          message: outcomes.length === 0 ? "No changes." : outcomes.join("; "),
        };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            isPromptCancellation(error)
              ? { ok: true, message: "Cancelled." }
              : { ok: false, message: error.message },
          ),
        ),
      ),
    reloadEntries: refreshEntries.pipe(
      Effect.catch(() => Ref.get(lastEntries)),
    ),
  });
});
