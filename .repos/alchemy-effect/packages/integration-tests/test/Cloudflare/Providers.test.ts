import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { Credentials } from "@alchemy.run/cloudflare/Credentials";
import { expect, it } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { AuthProvidersLive } from "alchemy/Auth/AuthProvider";
import * as Interaction from "alchemy/Interaction";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { v4 as uuidv4 } from "uuid";

it.live(
  "Cloudflare providers defer unknown explicit profile errors until credentials are requested",
  () =>
    Effect.gen(function* () {
      const providers = yield* Layer.build(Cloudflare.providers());
      for (const resolve of [
        Context.get(providers, CloudflareEnvironment).pipe(Effect.asVoid),
        Context.get(providers, Credentials).pipe(Effect.asVoid),
      ]) {
        const result = yield* Effect.result(Effect.sandbox(resolve));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(String(result.failure)).toContain("does not exist");
          expect(String(result.failure)).toContain("alchemy profile create");
        }
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
        ),
      ),
      Effect.provide(Interaction.layerNonInteractive()),
    ),
  { tags: ["unit", "provider:cloudflare", "local"] },
);

it.live(
  "builds Cloudflare providers from CI environment credentials without a profile",
  () =>
    Effect.gen(function* () {
      const providers = yield* Layer.build(Cloudflare.providers());
      const environment = yield* Context.get(providers, CloudflareEnvironment);
      expect(environment.accountId).toBe("0123456789abcdef0123456789abcdef");
      const credentials = yield* Context.get(providers, Credentials);
      expect(credentials.type).toBe("apiToken");
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
            ConfigProvider.fromUnknown({
              CI: true,
              CLOUDFLARE_API_TOKEN: "test-token",
              CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
              ALCHEMY_PROFILE: `non-existent-${uuidv4()}`,
            }),
          ),
          Layer.sync(ArtifactStore, createArtifactStore),
          NodeServices.layer,
          FetchHttpClient.layer,
        ),
      ),
      Effect.provide(Interaction.layerNonInteractive()),
    ),
  { tags: ["unit", "provider:cloudflare", "local"] },
);
