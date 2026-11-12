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









it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("readGrokAccount email", (it) => {
  it.effect("names the account whose limits were read, and nothing for other auth", () =>
    Effect.gen(function* () {
      const current = '"https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"';
      const cases = [
        [
          { GROK_AUTH: `{${current}:{"key":"t","email":" Someone@Example.com "}}` },
          "Someone@Example.com",
        ],
        [
          {
            GROK_AUTH: `{${current}:{"key":"t","email":"current@example.com"},"https://accounts.x.ai/sign-in":{"key":"t","email":"legacy@example.com"}}`,
          },
          "current@example.com",
        ],
        [{ GROK_AUTH: `{${current}:{"key":"t"}}` }, undefined],
        [
          {
            GROK_AUTH: `{${current}:{"key":"t","email":"someone@example.com"}}`,
            XAI_API_KEY: "api-key",
          },
          undefined,
        ],
        [
          {
            GROK_AUTH: `{${current}:{"key":"t","email":"someone@example.com","auth_mode":"api_key"}}`,
          },
          undefined,
        ],
        [{ GROK_AUTH: "not-json" }, undefined],
      ] as const;
      for (const [environment, expected] of cases) {
        const { email, usageLimits } = yield* readGrokAccount({
          HOME: "/definitely/not/a/grok-home",
          ...environment,
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ config: { creditUsagePercent: 25 } }),
                ),
              ),
            ),
          ),
        );
        expect(email).toBe(expected);
        if (expected) expect(usageLimits.windows[0]?.usedPercent).toBe(25);
      }
    }),
  );
});

