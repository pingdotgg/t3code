import {
  AuthProvider,
  AuthProviders,
  describeEnvironment,
  getAuthProvider,
} from "@/Auth/AuthProvider.ts";
import { getEnvRedactedRequired } from "@/Auth/Env.ts";
import { Interaction } from "@/Interaction.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { expect, it } from "alchemy-test";

const implementation = {
  configSchema: Schema.Struct({ method: Schema.Literal("custom") }),
  configure: () => Effect.succeed({ method: "custom" as const }),
  login: () => Effect.void,
  logout: () => Effect.void,
  details: () => Effect.succeed({ lines: [] }),
  read: () => Effect.void,
  readEnvironment: getEnvRedactedRequired("CUSTOM_PROVIDER_TOKEN").pipe(
    Effect.asVoid,
  ),
  environment: [
    { name: "CUSTOM_PROVIDER_TOKEN", required: true, secret: true },
    {
      name: "CUSTOM_PROVIDER_REGION",
      required: false,
      alternatives: ["CUSTOM_PROVIDER_DEFAULT_REGION"],
    },
  ],
};

it.effect("auth providers expose their declared environment contract", () =>
  Effect.gen(function* () {
    yield* AuthProvider<{ method: "custom" }, void>()(
      "CustomProvider",
      implementation,
    );
    const provider = yield* getAuthProvider("CustomProvider");

    expect(provider.environment).toEqual(implementation.environment);
    expect(describeEnvironment(provider.environment)).toBe(
      "CUSTOM_PROVIDER_TOKEN, [CUSTOM_PROVIDER_REGION | CUSTOM_PROVIDER_DEFAULT_REGION]",
    );
  }).pipe(
    Effect.provideService(AuthProviders, {}),
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("providers without environment credentials declare nothing", () =>
  Effect.gen(function* () {
    const {
      readEnvironment: _,
      environment: __,
      ...profileOnly
    } = implementation;
    yield* AuthProvider<{ method: "custom" }, void>()(
      "ProfileOnlyProvider",
      profileOnly,
    );
    const provider = yield* getAuthProvider("ProfileOnlyProvider");

    expect(provider.readEnvironment).toBeUndefined();
    expect(provider.environment).toEqual([]);
  }).pipe(
    Effect.provideService(AuthProviders, {}),
    Effect.provide(NodeServices.layer),
  ),
);

it.effect(
  "registration dies when readEnvironment lacks an environment declaration",
  () =>
    Effect.gen(function* () {
      const { environment: _, ...undeclared } = implementation;
      const exit = yield* AuthProvider<{ method: "custom" }, void>()(
        "UndeclaredProvider",
        undeclared,
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain(
          "declare its `environment` variables",
        );
      }
    }).pipe(
      Effect.provideService(AuthProviders, {}),
      Effect.provide(NodeServices.layer),
    ),
);

it.effect(
  "call-time Interaction wins over the one ambient at registration",
  () =>
    Effect.gen(function* () {
      const answered: string[] = [];
      const scripted = (name: string): Interaction["Service"] => ({
        output: {
          info: () => Effect.void,
          success: () => Effect.void,
          warning: () => Effect.void,
          error: () => Effect.void,
        },
        prompt: {
          text: () =>
            Effect.sync(() => {
              answered.push(name);
              return name;
            }),
          password: () => Effect.succeed(name),
          confirm: () => Effect.succeed(true),
          select: () => Effect.die("unused"),
          multiSelect: () => Effect.die("unused"),
          awaitExternal: () => Effect.succeed(name),
        },
        task: (_options, effect) => effect,
      });

      // Registered while "registration" is the ambient Interaction: the
      // factory's context snapshot must NOT capture it — configure's declared
      // requirement is resolved by whoever calls it.
      yield* AuthProvider<{ method: "custom" }, void>()("OverrideProvider", {
        ...implementation,
        configure: () =>
          Effect.gen(function* () {
            const interaction = yield* Interaction;
            yield* interaction.prompt
              .text({ message: "token" })
              .pipe(Effect.orDie);
            return { method: "custom" as const };
          }),
      }).pipe(Effect.provideService(Interaction, scripted("registration")));

      const provider = yield* getAuthProvider("OverrideProvider");
      yield* provider
        .configure("default")
        .pipe(Effect.provideService(Interaction, scripted("call-time")));

      expect(answered).toEqual(["call-time"]);
    }).pipe(
      Effect.provideService(AuthProviders, {}),
      Effect.provide(NodeServices.layer),
    ),
);
