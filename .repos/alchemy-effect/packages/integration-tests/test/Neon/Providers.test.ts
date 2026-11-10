import * as Neon from "@alchemy.run/neon";
import { Credentials } from "@alchemy.run/neon/Credentials";
import { Project } from "@alchemy.run/neon/Project";
import { expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { AuthProvidersLive } from "alchemy/Auth/AuthProvider";
import * as Interaction from "alchemy/Interaction";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { v4 as uuidv4 } from "uuid";

// Fresh providers rebuild on every deploy, re-registering the Neon auth
// provider under that deploy's ConfigProvider.
const { test } = Test.make({ providers: Layer.fresh(Neon.providers()) });

it.live(
  "resolving Neon credentials rejects an unknown explicit profile",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        Effect.sandbox(
          Effect.gen(function* () {
            return yield* yield* Credentials;
          }).pipe(Effect.provide(Neon.providers())),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("does not exist");
        expect(String(result.failure)).toContain("alchemy profile create");
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          AuthProvidersLive,
          Layer.succeed(Stage, "test"),
          Layer.succeed(Stack, {
            name: "test",
            stage: "test",
            resources: {},
            bindings: {},
            actions: {},
          }),
          Layer.succeed(AlchemyContext, { dev: false, adopt: false, dotAlchemy: ".alchemy" }),
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ALCHEMY_PROFILE: `non-existent-${uuidv4()}` }),
          ),
          Layer.sync(ArtifactStore, createArtifactStore),
          NodeServices.layer,
          FetchHttpClient.layer,
          Interaction.layerNonInteractive(),
        ),
      ),
    ),
  { tags: ["unit", "provider:neon", "local"] },
);

test.provider(
  "credentials resolve through their own ConfigProvider after a deploy under another",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // The profile's key, re-exposed as the CI environment variable.
      const { apiKey } = yield* yield* Credentials;
      const profileOnly = yield* ConfigProvider.ConfigProvider;
      const withEnvironmentKey = ConfigProvider.orElse(
        ConfigProvider.fromUnknown({ NEON_API_KEY: Redacted.value(apiKey) }),
        profileOnly,
      );
      const { project } = yield* Effect.gen(function* () {
        // Built under `NEON_API_KEY`, resolved only after the deploy below
        // has rebuilt (and re-registered) the Neon providers without it.
        const credentials = yield* Credentials;
        const deployed = yield* stack
          .deploy(
            Effect.gen(function* () {
              const project = yield* Project("ConfigProviderProject", {
                region: "aws-us-east-2",
              });
              return { project };
            }),
          )
          .pipe(Effect.provideService(ConfigProvider.ConfigProvider, profileOnly));
        expect(Redacted.value((yield* credentials).apiKey)).toBe(Redacted.value(apiKey));
        const observed = yield* SDK.getProject({ project_id: deployed.project.projectId });
        expect(observed.project.id).toBe(deployed.project.projectId);
        return deployed;
      }).pipe(
        Effect.provide(Layer.fresh(Neon.providers())),
        Effect.provideService(ConfigProvider.ConfigProvider, withEnvironmentKey),
      );

      yield* stack.destroy();
      const gone = yield* SDK.getProject({ project_id: project.projectId }).pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );
      expect(gone).toBe(true);
    }),
  { tags: ["provider:neon", "provider:neon:project", "live"], timeout: 120_000 },
);
