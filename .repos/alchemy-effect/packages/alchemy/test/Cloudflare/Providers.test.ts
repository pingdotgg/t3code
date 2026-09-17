import { AlchemyContext } from "@/AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "@/Artifacts.ts";
import { AuthProviders } from "@/Auth/AuthProvider.ts";
import * as CliKit from "@/Cli/CliKit/index.ts";
import * as Cloudflare from "@/Cloudflare";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { v4 as uuidv4 } from "uuid";

it.live(
  "building the Cloudflare provider layers rejects an unknown explicit profile",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        Effect.sandbox(Layer.build(Cloudflare.providers())),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("does not exist");
        expect(String(result.failure)).toContain("alchemy profile create");
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(AuthProviders, {}),
          Layer.succeed(Stage, "test"),
          Layer.succeed(Stack, {
            name: "test",
            stage: "test",
            resources: {},
            bindings: {},
            actions: {},
          }),
          Layer.succeed(AlchemyContext, {
            dev: false,
            adopt: false,
            dotAlchemy: ".alchemy",
          }),
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              ALCHEMY_PROFILE: `non-existent-${uuidv4()}`,
            }),
          ),
          Layer.sync(ArtifactStore, createArtifactStore),
          NodeServices.layer,
          FetchHttpClient.layer,
        ),
      ),
      Effect.provide(CliKit.layer({ input: false })),
    ),
);

it.live(
  "builds Cloudflare providers from CI environment credentials without a profile",
  () =>
    Effect.gen(function* () {
      yield* Layer.build(Cloudflare.providers());
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(AuthProviders, {}),
          Layer.succeed(Stage, "test"),
          Layer.succeed(Stack, {
            name: "test",
            stage: "test",
            resources: {},
            bindings: {},
            actions: {},
          }),
          Layer.succeed(AlchemyContext, {
            dev: false,
            adopt: false,
            dotAlchemy: ".alchemy",
          }),
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
      Effect.provide(CliKit.layer({ input: false })),
    ),
);
