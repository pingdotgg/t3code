import { AlchemyContext } from "@/AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "@/Artifacts.ts";
import { AuthProviders } from "@/Auth/AuthProvider.ts";
import * as CliKit from "@/Cli/CliKit/index.ts";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import { Credentials } from "@/Cloudflare/Credentials.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "alchemy-test";
import * as Context from "effect/Context";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
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
  { tags: ["unit", "provider:cloudflare", "local"] },
);
