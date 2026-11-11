import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import { readGrokAccount } from "./usageLimits.ts";

describe("Grok usage limits", () => {
  it.effect("explains that API keys do not report subscription limits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "grok-limits-" });
      const { usageLimits } = yield* readGrokAccount({
        HOME: home,
        XAI_API_KEY: "xai-test-key",
      });
      expect(usageLimits.unavailable).toEqual({
        reason: "unsupported",
        message:
          "Grok subscription limits need a default `grok login` session. API keys and custom authentication do not report them.",
      });
      expect(usageLimits.externalUsage).toEqual({
        label: "xAI console",
        url: "https://console.x.ai",
      });
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("API-key Grok must not request usage limits")),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );
});
