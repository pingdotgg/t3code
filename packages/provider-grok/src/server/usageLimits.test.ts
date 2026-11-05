import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { readGrokAccount } from "./usageLimits.ts";

it.layer(NodeServices.layer)("Grok quota deployment constraints", (it) => {
  const read = (config: string, shouldRequest: boolean) =>
    readGrokAccount({ GROK_HOME: "/quota-profile" }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: (path) => {
            if (path === "/quota-profile/requirements.toml") return Effect.succeed(config);
            if (path.endsWith("auth.json")) {
              expect(shouldRequest).toBe(true);
              return Effect.succeed(
                '{"https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828":{"key":"test-session","auth_mode":"oauth"}}',
              );
            }
            return Effect.succeed("");
          },
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          expect(shouldRequest).toBe(true);
          expect(request.url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ config: { creditUsagePercent: 37 } }),
            ),
          );
        }),
      ),
    );

  it.effect("keeps OAuth quota reads under the API-key prohibition", () =>
    Effect.gen(function* () {
      for (const config of [
        "[grok_com_config]\ndisable_api_key_auth = true\n",
        '# policy\n["grok_com_config"]\n"disable_api_key_auth" = true # OAuth only\n',
        "grok_com_config = { disable_api_key_auth = true }\n",
      ]) {
        const result = yield* read(config, true);
        expect(result.usageLimits.windows[0]?.usedPercent).toBe(37);
      }
    }),
  );

  it.effect("refuses unknown deployment overrides before reading credentials", () =>
    Effect.gen(function* () {
      for (const config of [
        '[auth]\nissuer = "https://other.example"\n',
        '[endpoints]\nbase_url = "https://other.example"\n',
        '[grok_com_config]\ndisable_api_key_auth = true\naccount = "other"\n',
        '[grok_com_config]\ndisable_api_key_auth = "true"\n',
        "grok_com_config = 2026-11-05\n",
        'grok_com_config = { disable_api_key_auth = true, account = "other" }\n',
      ]) {
        const result = yield* read(config, false);
        expect(result.usageLimits.unavailable?.reason).toBe("unsupported");
      }
    }),
  );

  it.effect("sanitizes invalid TOML and never reads its credentials", () =>
    Effect.gen(function* () {
      const result = yield* read('[grok_com_config]\ndisable_api_key_auth = "private', false);
      expect(result.usageLimits.unavailable).toEqual({
        reason: "probeFailed",
        message: "Grok could not read usage limits.",
      });
    }),
  );
});
