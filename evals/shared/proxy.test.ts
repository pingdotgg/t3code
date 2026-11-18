import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { vi } from "vite-plus/test";

import { morphConfig } from "./proxy.ts";

it.live.each(["v1", "v2", "environment"] as const)(
  "reads Morph credentials from %s without a model request",
  (source) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configHome = yield* fs.makeTempDirectoryScoped({ prefix: "morph-eval-config-" });
      const settings = { apiKey: "eval-config-key", baseURL: "https://config.invalid/v1/" };
      if (source !== "environment") {
        yield* fs.makeDirectory(`${configHome}/opencode`);
        yield* fs.writeFileString(
          `${configHome}/opencode/opencode.json`,
          JSON.stringify(
            source === "v1"
              ? { provider: { morph: { options: settings } } }
              : { providers: { morph: { settings } } },
          ),
        );
      }
      vi.stubEnv("XDG_CONFIG_HOME", configHome);
      vi.stubEnv("MORPH_API_KEY", source === "environment" ? "eval-environment-key" : undefined);
      vi.stubEnv(
        "MORPH_BASE_URL",
        source === "environment" ? "https://environment.invalid/v1/" : undefined,
      );
      try {
        expect(morphConfig()).toEqual({
          url:
            source === "environment"
              ? "https://environment.invalid/v1"
              : "https://config.invalid/v1",
          headers: {
            Authorization: `Bearer ${source === "environment" ? "eval-environment-key" : "eval-config-key"}`,
          },
        });
      } finally {
        vi.unstubAllEnvs();
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
