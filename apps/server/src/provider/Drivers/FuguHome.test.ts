import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import {
  buildFuguConfigToml,
  ensureFuguHome,
  FUGU_MODEL_CATALOG_PATH,
  resolveFuguHomePath,
  resolveFuguModelCatalogPath,
} from "./FuguHome.ts";

it.layer(NodeServices.layer)("FuguHome", (it) => {
  describe("path resolution", () => {
    it.effect("expands the default home and catalog tilde paths", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(resolveFuguHomePath("")).toBe(path.join(NodeOS.homedir(), ".codex", "fugu-home"));
        expect(resolveFuguHomePath("~/.codex/fugu-home")).toBe(
          path.join(NodeOS.homedir(), ".codex", "fugu-home"),
        );
        expect(resolveFuguModelCatalogPath()).toBe(
          path.join(NodeOS.homedir(), ".codex", "fugu.json"),
        );
        expect(FUGU_MODEL_CATALOG_PATH).toBe("~/.codex/fugu.json");
      }),
    );
  });

  describe("buildFuguConfigToml", () => {
    it("embeds the absolute catalog path and sakana provider block", () => {
      const toml = buildFuguConfigToml("/Users/serge/.codex/fugu.json");
      expect(toml).toContain('model = "fugu-ultra"');
      expect(toml).toContain('model_reasoning_effort = "xhigh"');
      expect(toml).toContain('model_provider = "sakana"');
      expect(toml).toContain('model_catalog_json = "/Users/serge/.codex/fugu.json"');
      expect(toml).toContain("[model_providers.sakana]");
      expect(toml).toContain('env_key = "SAKANA_API_KEY"');
      expect(toml).toContain('wire_api = "responses"');
      expect(toml).toContain("stream_idle_timeout_ms = 7_200_000");
    });
  });

  describe("ensureFuguHome", () => {
    it.effect("writes config.toml when missing and catalog exists", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fugu-home-" });
        const homePath = path.join(tempRoot, "fugu-home");
        const catalogPath = path.join(tempRoot, "fugu.json");
        yield* fileSystem.writeFileString(catalogPath, '{"models":[]}\n');

        const resolved = yield* ensureFuguHome({ homePath }, { catalogPath });
        expect(resolved).toBe(path.resolve(homePath));

        const configPath = path.join(homePath, "config.toml");
        const contents = yield* fileSystem.readFileString(configPath);
        expect(contents).toContain(`model_catalog_json = "${path.resolve(catalogPath)}"`);
        expect(contents).toContain("[model_providers.sakana]");
        expect(contents).toContain('model = "fugu-ultra"');
      }),
    );

    it.effect("does not clobber an existing config.toml", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fugu-home-" });
        const homePath = path.join(tempRoot, "fugu-home");
        const catalogPath = path.join(tempRoot, "fugu.json");
        yield* fileSystem.writeFileString(catalogPath, '{"models":[]}\n');
        yield* fileSystem.makeDirectory(homePath, { recursive: true });
        const configPath = path.join(homePath, "config.toml");
        const sentinel = '# user-owned fugu config\nmodel = "custom"\n';
        yield* fileSystem.writeFileString(configPath, sentinel);

        yield* ensureFuguHome({ homePath }, { catalogPath });
        const contents = yield* fileSystem.readFileString(configPath);
        expect(contents).toBe(sentinel);
      }),
    );

    it.effect("fails with an install hint when the model catalog is missing", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fugu-home-" });
        const homePath = path.join(tempRoot, "fugu-home");
        const missingCatalog = path.join(tempRoot, "missing-fugu.json");

        const result = yield* ensureFuguHome({ homePath }, { catalogPath: missingCatalog }).pipe(
          Effect.result,
        );

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toMatch(/Install codex-fugu/);
          expect(result.failure.message).toMatch(/fugu\.json/);
        }

        // Home must not be partially created without a valid catalog.
        const configExists = yield* fileSystem.exists(path.join(homePath, "config.toml"));
        expect(configExists).toBe(false);
      }),
    );
  });
});
