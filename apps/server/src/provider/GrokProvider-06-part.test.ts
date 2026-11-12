// @effect-diagnostics nodeBuiltinImport:off - resolves the mock ACP agent script path relative to this test file.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { GrokSettings } from "@t3tools/provider-grok/settings";

import {
  buildGrokModelCapabilities,
  checkGrokProviderStatus,
  grokSlashCommandsFromInitialize,
  parseGrokModelsCliOutput,
} from "@t3tools/provider-grok/testing";
import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { grokUsageResponseToLimits, readGrokAccount } from "@t3tools/provider-grok/testing";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const LOGGED_IN_MODELS_OUTPUT = [
  "You are logged in with grok.com.",
  "",
  "Default model: grok-4.6",
  "",
  "Available models:",
  "  * grok-4.6 (default)",
  "  - grok-4.5",
  "",
].join("\n");

const LOGGED_OUT_MODELS_OUTPUT = LOGGED_IN_MODELS_OUTPUT.replace(
  "You are logged in with grok.com.",
  "You are not authenticated.",
);









it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("readGrokAccount", (it) => {
  it.effect("reads the configured Grok home and prefers the current login scope to legacy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        NodePath.join(directory, "auth.json"),
        '{"https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828":{"key":"session-token","auth_mode":"oauth"},"https://accounts.x.ai/sign-in":{"key":"legacy-token"}}',
      );
      const { usageLimits: limits } = yield* readGrokAccount({
        GROK_HOME: directory,
        HOME: "/unrelated-home",
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            expect(request.method).toBe("GET");
            expect(request.url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
            expect(request.headers.authorization).toBe("Bearer session-token");
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ config: { creditUsagePercent: 37 } }),
              ),
            );
          }),
        ),
      );
      expect(limits.windows[0]?.usedPercent).toBe(37);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "uses GROK_AUTH without reading stored credentials and accepts the legacy login scope",
    () =>
      readGrokAccount({
        GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"legacy-token"}}',
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: (path) =>
              path.endsWith("auth.json")
                ? Effect.die("must not read stored credentials")
                : Effect.succeed(""),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            expect(request.headers.authorization).toBe("Bearer legacy-token");
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ config: { creditUsagePercent: 12 } }),
              ),
            );
          }),
        ),
        Effect.tap(({ usageLimits }) =>
          Effect.sync(() => expect(usageLimits.windows[0]?.usedPercent).toBe(12)),
        ),
      ),
  );

  it.effect("does not use unrelated scopes, API keys, or custom auth deployments", () =>
    Effect.gen(function* () {
      for (const environment of [
        {
          GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"stored-account"}}',
          XAI_API_KEY: "different-api-account",
        },
        { GROK_AUTH: '{"https://other.example":{"key":"unrelated-token"}}' },
        { GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"api-key","auth_mode":"api_key"}}' },
        { GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":" "}}' },
        {
          GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"session-token"}}',
          GROK_OIDC_ISSUER: "https://custom.example",
        },
        {
          GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"stored-account"}}',
          GROK_MODELS_BASE_URL: "https://custom.example/v1",
        },
        {
          GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"stored-account"}}',
          GROK_OAUTH2_PRINCIPAL_TYPE: "Team",
        },
        {
          GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"stored-account"}}',
          GROK_OAUTH2_PRINCIPAL_ID: "team-id",
        },
        {
          GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"session-token"}}',
          GROK_CONFIG: '{"auth_provider_command":"custom-auth"}',
        },
        {
          GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"session-token"}}',
          GROK_CONFIG_PATH: "/custom-config.toml",
        },
      ]) {
        const { usageLimits: limits } = yield* readGrokAccount({
          HOME: "/definitely/not/a/grok-home",
          ...environment,
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not request another account's quota")),
          ),
        );
        expect(limits.windows).toEqual([]);
        expect(limits.unavailable?.reason).toBe("unsupported");
      }
    }),
  );

  it.effect(
    "reports a missing login as unsupported and malformed credentials as a sanitized failure",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const client = HttpClient.make(() => Effect.die("must not request without credentials"));
        const { usageLimits: missing } = yield* readGrokAccount({ HOME: directory }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
        expect(missing.unavailable?.reason).toBe("unsupported");
        for (const contents of [
          "private-token-invalid-json",
          '{"https://accounts.x.ai/sign-in":{"key":42}}',
        ]) {
          const { usageLimits: malformed } = yield* readGrokAccount({
            GROK_HOME: directory,
            GROK_AUTH: contents,
          }).pipe(Effect.provideService(HttpClient.HttpClient, client));
          expect(malformed.unavailable).toEqual({
            reason: "probeFailed",
            message: "Grok could not read usage limits.",
          });
        }
      }).pipe(Effect.scoped),
  );

  it.effect("sanitizes HTTP failures and malformed billing responses, keeping the account", () =>
    Effect.gen(function* () {
      for (const response of [
        new Response("private response", { status: 401 }),
        Response.json({ config: { creditUsagePercent: "private-value" } }),
      ]) {
        const { email, usageLimits: limits } = yield* readGrokAccount({
          HOME: "/definitely/not/a/grok-home",
          GROK_AUTH:
            '{"https://accounts.x.ai/sign-in":{"key":"private-token","email":"someone@example.com"}}',
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, response)),
            ),
          ),
        );
        expect(email).toBe("someone@example.com");
        expect(limits.windows).toEqual([]);
        expect(limits.unavailable).toEqual({
          reason: "probeFailed",
          message: "Grok could not read usage limits.",
        });
      }
    }),
  );

  it.effect("tells accounts in Legacy (no storage) to switch to Privacy Mode", () =>
    Effect.gen(function* () {
      const { usageLimits: limits } = yield* readGrokAccount({
        HOME: "/definitely/not/a/grok-home",
        GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"private-token"}}',
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  {
                    error:
                      "Grok Build is not supported in Legacy (no storage). Switch to Privacy Mode to use Grok Build. [WKE=privacy-mode:legacy]",
                  },
                  { status: 403 },
                ),
              ),
            ),
          ),
        ),
      );
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(limits.unavailable?.message).toMatch(/Privacy Mode/);
      expect(limits.unavailable?.message).not.toMatch(/WKE=|Grok Build is not supported/);
    }),
  );
});

