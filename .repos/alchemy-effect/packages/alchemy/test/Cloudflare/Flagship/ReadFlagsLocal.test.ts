import { Action } from "@/Action";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { poll } from "@/Util/poll.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Reading Flagship feature flags inside an Action via `ReadFlagsLocal` — the
// local (current-credentials) implementation of the `ReadFlags` binding. It
// evaluates flags over the HTTP `evaluate` endpoint instead of the native
// Worker binding. Exercises the value + details client methods and the accessor
// mechanism (`yield* app.appId` resolved at apply time).
test.provider(
  "ReadFlagsLocal: evaluate a flag from an Action",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const key = "alchemy-test-flag-read-local";

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Cloudflare.Flagship.App("ReadFlagsLocalApp", {
            name: "alchemy-test-flagship-read-local",
          });
          // defaultVariation "on" -> with no rules the flag always evaluates
          // to `true`, which is distinct from the client-side default `false`,
          // so a successful read is observable.
          yield* Cloudflare.Flagship.Flag("ReadFlagsLocalFlag", {
            appId: app.appId,
            key,
            defaultVariation: "on",
            variations: { off: false, on: true },
          });

          const Read = Action(
            "Read",
            Effect.gen(function* () {
              const flags = yield* Cloudflare.Flagship.ReadFlags(app);

              return Effect.fn(function* () {
                // The edge `evaluate` endpoint can lag a freshly-created flag;
                // poll until it returns the flag's true value (bounded).
                const enabled = yield* poll({
                  description: "evaluate returns the flag value",
                  effect: flags.getBooleanValue(key, false),
                  predicate: (v) => v === true,
                  schedule: Schedule.max([
                    Schedule.spaced("3 seconds"),
                    Schedule.recurs(20),
                  ]),
                });

                const details = yield* flags.getBooleanDetails(key, false);
                // A boolean flag read as a string falls back to the default.
                const asString = yield* flags.getStringValue(key, "fallback");
                const untyped = yield* flags.get(key);

                return { enabled, details, asString, untyped };
              });
            }).pipe(Effect.provide(Cloudflare.Flagship.ReadFlagsLocal)),
          );

          return yield* Read({});
        }),
      );

      expect(out.enabled).toBe(true);
      expect(out.details.flagKey).toBe(key);
      expect(out.details.value).toBe(true);
      expect(out.details.variant).toBe("on");
      expect(out.asString).toBe("fallback");
      expect(out.untyped).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
