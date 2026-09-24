import {
  runBuildCommand,
  runComputeAutoBuild,
  runComputeStaticBuild,
} from "@/Prisma/ComputeBuild";
import { createComputeArchive } from "@/Prisma/ComputeArchive";
import { PlatformServices } from "@/Util/PlatformServices";
import { findAvailablePort } from "@/Util/Node";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { gunzipSync } from "node:zlib";

const inspectBuildEnvironmentCommand = [
  JSON.stringify(process.execPath),
  "-e",
  JSON.stringify(
    "process.stdout.write(JSON.stringify({ serviceToken: process.env.PRISMA_SERVICE_TOKEN ?? null, apiToken: process.env.PRISMA_API_TOKEN ?? null, inherited: process.env.ALCHEMY_BUILD_INHERITED_SENTINEL ?? null }))",
  ),
].join(" ");

const restoreProcessEnv = (name: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

describe("Prisma Compute auto-build", () => {
  it.effect("builds a Bun app from package.json main", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-bun-",
      });
      yield* fs.makeDirectory(path.join(root, "src"));
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ main: "src/server.ts" }),
      );
      yield* fs.writeFileString(
        path.join(root, "src", "server.ts"),
        "console.log('auto bun');",
      );

      const artifact = yield* runComputeAutoBuild({
        appPath: root,
        framework: "bun",
      });
      const entrypointText = yield* fs.readFileString(
        path.join(artifact.directory, artifact.entrypoint),
      );

      expect(artifact.entrypoint).toBe("server.js");
      expect(entrypointText).toContain("auto bun");

      yield* artifact.cleanup;
      expect(yield* fs.exists(artifact.directory)).toBe(false);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("builds a NestJS app from local CLI output", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-nest-",
      });
      const binDir = path.join(root, "node_modules", ".bin");
      const nestBin = path.join(binDir, "nest");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { "@nestjs/core": "0.0.0-test" } }),
      );
      yield* fs.writeFileString(nestBin, "#!/usr/bin/env sh\nexit 0\n");
      yield* fs.chmod(nestBin, 0o755);
      yield* fs.makeDirectory(path.join(root, "dist"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "dist", "main.js"),
        "console.log('nest server');",
      );

      const artifact = yield* runComputeAutoBuild({
        appPath: root,
        framework: "nestjs",
      });

      expect(artifact.entrypoint).toBe("dist/main.js");
      expect(artifact.defaultPort).toBe(3000);
      expect(
        yield* fs.readFileString(path.join(artifact.directory, "dist/main.js")),
      ).toContain("nest server");

      yield* artifact.cleanup;
      expect(yield* fs.exists(artifact.directory)).toBe(false);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("auto-detects NestJS before the Bun fallback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-nest-detect-",
      });
      const binDir = path.join(root, "node_modules", ".bin");
      const nestBin = path.join(binDir, "nest");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { "@nestjs/core": "0.0.0-test" } }),
      );
      yield* fs.writeFileString(nestBin, "#!/usr/bin/env sh\nexit 0\n");
      yield* fs.chmod(nestBin, 0o755);
      yield* fs.makeDirectory(path.join(root, "dist", "src"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(root, "dist", "src", "main.js"),
        "console.log('auto nest');",
      );

      const artifact = yield* runComputeAutoBuild({ appPath: root });

      expect(artifact.entrypoint).toBe("dist/src/main.js");

      yield* artifact.cleanup;
      expect(yield* fs.exists(artifact.directory)).toBe(false);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("forwards output limits to framework build commands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-build-limit-",
      });
      const binDir = path.join(root, "node_modules", ".bin");
      const nestBin = path.join(binDir, "nest");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { "@nestjs/core": "0.0.0-test" } }),
      );
      yield* fs.writeFileString(
        nestBin,
        "#!/usr/bin/env sh\nprintf '123456789'\n",
      );
      yield* fs.chmod(nestBin, 0o755);

      const error = yield* runComputeAutoBuild({
        appPath: root,
        framework: "nestjs",
        outputLimitBytes: 8,
      }).pipe(Effect.flip);

      expect((error as Error).message).toContain(
        "Build stdout exceeded the 8 byte output safety limit",
      );
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.live("forwards deadlines to framework build commands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-build-timeout-",
      });
      const binDir = path.join(root, "node_modules", ".bin");
      const nestBin = path.join(binDir, "nest");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { "@nestjs/core": "0.0.0-test" } }),
      );
      yield* fs.writeFileString(nestBin, "#!/usr/bin/env sh\nsleep 10\n");
      yield* fs.chmod(nestBin, 0o755);

      const error = yield* runComputeAutoBuild({
        appPath: root,
        framework: "nestjs",
        timeoutSeconds: 0.05,
      }).pipe(Effect.flip);

      expect((error as Error).message).toContain(
        "Build command timed out after 0.05 seconds",
      );
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect(
    "resolves NestJS config output and stages traced dependencies",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-auto-nest-trace-",
        });
        const binDir = path.join(root, "node_modules", ".bin");
        const nestBin = path.join(binDir, "nest");
        yield* fs.makeDirectory(binDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { "@nestjs/core": "0.0.0-test" } }),
        );
        yield* fs.writeFileString(
          path.join(root, "nest-cli.json"),
          JSON.stringify({ sourceRoot: "app", entryFile: "bootstrap" }),
        );
        yield* fs.writeFileString(
          path.join(root, "tsconfig.json"),
          [
            "{",
            "  // Keep URLs with // intact while reading compiler options.",
            '  "compilerOptions": {',
            '    "outDir": "build",',
            '    "sourceMappingURL": "https://example.com//maps"',
            "  }",
            "}",
          ].join("\n"),
        );
        yield* fs.writeFileString(nestBin, "#!/usr/bin/env sh\nexit 0\n");
        yield* fs.chmod(nestBin, 0o755);

        const usedDep = path.join(root, "node_modules", "used-dep");
        const unusedDep = path.join(root, "node_modules", "unused-dep");
        yield* fs.makeDirectory(usedDep, { recursive: true });
        yield* fs.writeFileString(
          path.join(usedDep, "package.json"),
          JSON.stringify({ name: "used-dep", main: "index.js" }),
        );
        yield* fs.writeFileString(
          path.join(usedDep, "index.js"),
          "module.exports = 'used';",
        );
        yield* fs.makeDirectory(unusedDep, { recursive: true });
        yield* fs.writeFileString(
          path.join(unusedDep, "package.json"),
          JSON.stringify({ name: "unused-dep", main: "index.js" }),
        );
        yield* fs.writeFileString(
          path.join(unusedDep, "index.js"),
          "module.exports = 'unused';",
        );
        yield* fs.makeDirectory(path.join(root, "build", "app"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(root, "build", "app", "bootstrap.js"),
          "const used = require('used-dep'); console.log(used);",
        );

        const artifact = yield* runComputeAutoBuild({
          appPath: root,
          framework: "nestjs",
        });

        expect(artifact.entrypoint).toBe("build/app/bootstrap.js");
        expect(
          yield* fs.exists(
            path.join(
              artifact.directory,
              "node_modules",
              "used-dep",
              "index.js",
            ),
          ),
        ).toBe(true);
        expect(
          yield* fs.exists(
            path.join(artifact.directory, "node_modules", "unused-dep"),
          ),
        ).toBe(false);

        yield* artifact.cleanup;
        expect(yield* fs.exists(artifact.directory)).toBe(false);
      }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect(
    "uses a project-local framework CLI and copies Next.js extras",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-auto-next-",
        });
        const binDir = path.join(root, "node_modules", ".bin");
        const nextBin = path.join(binDir, "next");
        yield* fs.makeDirectory(binDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
        );
        yield* fs.writeFileString(
          nextBin,
          [
            "#!/bin/sh",
            "mkdir -p .next/standalone .next/static public",
            "printf 'next server' > .next/standalone/server.js",
            "printf 'next static' > .next/static/app.js",
            "printf 'next public' > public/asset.txt",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(nextBin, 0o755);

        const artifact = yield* runComputeAutoBuild({
          appPath: root,
          framework: "nextjs",
        });

        expect(artifact.entrypoint).toBe("server.js");
        expect(artifact.defaultPort).toBe(3000);
        expect(
          yield* fs.readFileString(path.join(artifact.directory, "server.js")),
        ).toBe("next server");
        expect(
          yield* fs.readFileString(
            path.join(artifact.directory, ".next", "static", "app.js"),
          ),
        ).toBe("next static");
        expect(
          yield* fs.readFileString(
            path.join(artifact.directory, "public", "asset.txt"),
          ),
        ).toBe("next public");

        yield* artifact.cleanup;
        expect(yield* fs.exists(artifact.directory)).toBe(false);
      }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("uses an installed workspace framework CLI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-workspace-cli-",
      });
      const appPath = path.join(root, "apps", "web");
      const binDir = path.join(root, "node_modules", ".bin");
      const nextBin = path.join(binDir, "next");
      yield* fs.makeDirectory(appPath, { recursive: true });
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ workspaces: ["apps/*"] }),
      );
      yield* fs.writeFileString(
        path.join(appPath, "package.json"),
        JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
      );
      yield* fs.writeFileString(
        nextBin,
        [
          "#!/bin/sh",
          "mkdir -p .next/standalone",
          "printf 'workspace next server' > .next/standalone/server.js",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(nextBin, 0o755);

      const artifact = yield* runComputeAutoBuild({
        appPath,
        framework: "nextjs",
      });

      expect(
        yield* fs.readFileString(path.join(artifact.directory, "server.js")),
      ).toBe("workspace next server");
      yield* artifact.cleanup;
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("never downloads a missing framework CLI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-no-network-cli-",
      });
      const fakeBin = path.join(root, "fake-bin");
      const fallbackMarker = path.join(root, "network-fallback-ran");
      yield* fs.makeDirectory(fakeBin, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
      );
      for (const executable of ["npx", "bunx"]) {
        const executablePath = path.join(fakeBin, executable);
        yield* fs.writeFileString(
          executablePath,
          `#!/bin/sh\nprintf invoked > ${JSON.stringify(fallbackMarker)}\nexit 127\n`,
        );
        yield* fs.chmod(executablePath, 0o755);
      }

      const error = yield* runComputeAutoBuild({
        appPath: root,
        framework: "nextjs",
        env: { PATH: fakeBin },
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Could not find an installed Next.js CLI",
      );
      expect(yield* fs.exists(fallbackMarker)).toBe(false);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("rejects framework symlinks that escape the output root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-link-escape-",
      });
      const binDir = path.join(root, "node_modules", ".bin");
      const nextBin = path.join(binDir, "next");
      const standalone = path.join(root, ".next", "standalone");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.makeDirectory(standalone, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
      );
      yield* fs.writeFileString(nextBin, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(nextBin, 0o755);
      yield* fs.writeFileString(
        path.join(standalone, "server.js"),
        "console.log('server');",
      );
      yield* fs.writeFileString(path.join(root, "outside.txt"), "secret");
      yield* fs.symlink(
        "../../outside.txt",
        path.join(standalone, "outside.txt"),
      );

      const error = yield* runComputeAutoBuild({
        appPath: root,
        framework: "nextjs",
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Compute artifact path escapes its staging root",
      );
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect(
    "rejects a framework output directory outside the application",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-auto-output-root-escape-",
        });
        const outside = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-auto-external-output-",
        });
        const binDir = path.join(root, "node_modules", ".bin");
        const nextBin = path.join(binDir, "next");
        yield* fs.makeDirectory(binDir, { recursive: true });
        yield* fs.makeDirectory(path.join(root, ".next"), { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
        );
        yield* fs.writeFileString(nextBin, "#!/bin/sh\nexit 0\n");
        yield* fs.chmod(nextBin, 0o755);
        yield* fs.writeFileString(
          path.join(outside, "server.js"),
          "console.log('server');",
        );
        yield* fs.symlink(outside, path.join(root, ".next", "standalone"));

        const error = yield* runComputeAutoBuild({
          appPath: root,
          framework: "nextjs",
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          "Compute artifact path escapes its staging root",
        );
      }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect(
    "rejects an oversized framework output file before copying it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-auto-oversized-file-",
        });
        const binDir = path.join(root, "node_modules", ".bin");
        const nextBin = path.join(binDir, "next");
        const standalone = path.join(root, ".next", "standalone");
        const server = path.join(standalone, "server.js");
        yield* fs.makeDirectory(binDir, { recursive: true });
        yield* fs.makeDirectory(standalone, { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
        );
        yield* fs.writeFileString(nextBin, "#!/bin/sh\nexit 0\n");
        yield* fs.chmod(nextBin, 0o755);
        yield* fs.writeFileString(server, "");
        yield* fs.truncate(server, 128 * 1024 * 1024 + 1);

        const error = yield* runComputeAutoBuild({
          appPath: root,
          framework: "nextjs",
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          "134217728 byte per-file safety limit",
        );
      }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("detects nested Next.js standalone entrypoints in monorepos", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-next-monorepo-",
      });
      const binDir = path.join(root, "node_modules", ".bin");
      const nextBin = path.join(binDir, "next");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
      );
      yield* fs.writeFileString(
        nextBin,
        [
          "#!/bin/sh",
          "mkdir -p .next/standalone/examples/prisma-nextjs .next/standalone/node_modules/pkg .next/static public",
          "printf 'nested next server' > .next/standalone/examples/prisma-nextjs/server.js",
          "printf 'dependency server' > .next/standalone/node_modules/pkg/server.js",
          "printf 'next static' > .next/static/app.js",
          "printf 'next public' > public/asset.txt",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(nextBin, 0o755);

      const artifact = yield* runComputeAutoBuild({
        appPath: root,
        framework: "nextjs",
      });

      expect(artifact.entrypoint).toBe("examples/prisma-nextjs/server.js");
      expect(
        yield* fs.readFileString(
          path.join(artifact.directory, artifact.entrypoint),
        ),
      ).toBe("nested next server");
      expect(
        yield* fs.readFileString(
          path.join(
            artifact.directory,
            "examples",
            "prisma-nextjs",
            ".next",
            "static",
            "app.js",
          ),
        ),
      ).toBe("next static");
      expect(
        yield* fs.readFileString(
          path.join(
            artifact.directory,
            "examples",
            "prisma-nextjs",
            "public",
            "asset.txt",
          ),
        ),
      ).toBe("next public");

      yield* artifact.cleanup;
      expect(yield* fs.exists(artifact.directory)).toBe(false);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("rejects ambiguous Next.js standalone entrypoints", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-auto-next-ambiguous-",
      });
      const binDir = path.join(root, "node_modules", ".bin");
      const nextBin = path.join(binDir, "next");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
      );
      yield* fs.writeFileString(
        nextBin,
        [
          "#!/bin/sh",
          "mkdir -p .next/standalone/apps/web .next/standalone/apps/admin",
          "printf 'web server' > .next/standalone/apps/web/server.js",
          "printf 'admin server' > .next/standalone/apps/admin/server.js",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(nextBin, 0o755);

      const error = yield* runComputeAutoBuild({
        appPath: root,
        framework: "nextjs",
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("multiple server.js files");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect(
    "materializes Bun package aliases for Next.js standalone output",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-auto-next-bun-aliases-",
        });
        const binDir = path.join(root, "node_modules", ".bin");
        const nextBin = path.join(binDir, "next");
        yield* fs.makeDirectory(binDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
        );
        yield* fs.writeFileString(
          nextBin,
          [
            "#!/bin/sh",
            "set -eu",
            "mkdir -p .next/standalone/examples/prisma-nextjs",
            "mkdir -p .next/standalone/node_modules/.bun/@swc+helpers@0.5.15/node_modules/@swc/helpers",
            "mkdir -p .next/standalone/node_modules/.bun/node_modules/@swc",
            "printf 'nested next server' > .next/standalone/examples/prisma-nextjs/server.js",
            'printf \'{"name":"@swc/helpers"}\' > .next/standalone/node_modules/.bun/@swc+helpers@0.5.15/node_modules/@swc/helpers/package.json',
            "ln -s ../../@swc+helpers@0.5.15/node_modules/@swc/helpers .next/standalone/node_modules/.bun/node_modules/@swc/helpers",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(nextBin, 0o755);

        const artifact = yield* runComputeAutoBuild({
          appPath: root,
          framework: "nextjs",
        });

        expect(artifact.entrypoint).toBe("examples/prisma-nextjs/server.js");
        expect(
          yield* fs.readFileString(
            path.join(
              artifact.directory,
              "node_modules",
              "@swc",
              "helpers",
              "package.json",
            ),
          ),
        ).toBe('{"name":"@swc/helpers"}');

        yield* artifact.cleanup;
        expect(yield* fs.exists(artifact.directory)).toBe(false);
      }).pipe(Effect.provide(PlatformServices)),
  );

  it.live("auto-detects a Vite static SPA", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root } = yield* copyStaticBuildFixture;
      const artifact = yield* runComputeAutoBuild({ appPath: root });
      yield* Effect.addFinalizer(() => artifact.cleanup);
      const index = yield* fs.readFileString(
        path.join(root, "dist/index.html"),
      );

      expect(artifact.entrypoint).toBe("server.mjs");
      expect(artifact.defaultPort).toBe(8080);
      expect(artifact.archiveIgnorePrefix).toBe("public");
      expect(artifact.requiredFiles).toEqual(["public/index.html"]);
      expect(index).toContain("<h1>app shell</h1>");
      expect(index).toContain("/assets/app.js");
      expect(
        yield* fs.readFileString(
          path.join(artifact.directory, "public", "index.html"),
        ),
      ).toBe(index);

      yield* withStaticSiteServer(artifact.directory, (origin) =>
        Effect.gen(function* () {
          const response = yield* HttpClient.get(`${origin}/dashboard`);
          expect(response.status).toBe(200);
          expect(yield* response.text).toBe(index);
        }),
      );

      yield* artifact.cleanup;
      expect(yield* fs.exists(artifact.directory)).toBe(false);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.live("detects TanStack Start before the Vite fallback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root } = yield* copyStaticBuildFixture;
      // Declaring Start without its plugins must not silently deploy a SPA.
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({
          type: "module",
          dependencies: { "@tanstack/react-start": "*" },
          devDependencies: { vite: "*" },
        }),
      );

      const error = yield* runComputeAutoBuild({ appPath: root }).pipe(
        Effect.flip,
      );

      expect((error as Error).message).toContain(
        "TanStack Start build did not produce a Nitro node server entrypoint at .output/server/index.mjs",
      );
      expect(
        yield* fs.readFileString(path.join(root, "dist/index.html")),
      ).toContain("/assets/app.js");
      expect(
        yield* fs.exists(path.join(root, ".output/server/index.mjs")),
      ).toBe(false);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("bounds retained build stdout", () =>
    Effect.gen(function* () {
      const error = yield* runBuildCommand({
        command: "printf '123456789'",
        outputLimitBytes: 8,
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Build stdout exceeded the 8 byte output safety limit",
      );
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("bounds retained build stderr", () =>
    Effect.gen(function* () {
      const error = yield* runBuildCommand({
        command: "printf '123456789' >&2",
        outputLimitBytes: 8,
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Build stderr exceeded the 8 byte output safety limit",
      );
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("does not expose failed build output in errors", () =>
    Effect.gen(function* () {
      const error = yield* runBuildCommand({
        command: "printf 'BUILD_SECRET_SENTINEL' >&2; exit 17",
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("exit code 17");
      expect((error as Error).message).toContain("stderr: 21 bytes");
      expect((error as Error).message).not.toContain("BUILD_SECRET_SENTINEL");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("withholds ambient Prisma credentials from build commands", () =>
    Effect.gen(function* () {
      const previousServiceToken = process.env.PRISMA_SERVICE_TOKEN;
      const previousApiToken = process.env.PRISMA_API_TOKEN;
      const previousInherited = process.env.ALCHEMY_BUILD_INHERITED_SENTINEL;
      process.env.PRISMA_SERVICE_TOKEN = "ambient-service-token";
      process.env.PRISMA_API_TOKEN = "ambient-api-token";
      process.env.ALCHEMY_BUILD_INHERITED_SENTINEL = "inherited-value";

      try {
        const result = yield* runBuildCommand({
          command: inspectBuildEnvironmentCommand,
        });

        expect(JSON.parse(result.stdout)).toEqual({
          serviceToken: null,
          apiToken: null,
          inherited: "inherited-value",
        });
      } finally {
        restoreProcessEnv("PRISMA_SERVICE_TOKEN", previousServiceToken);
        restoreProcessEnv("PRISMA_API_TOKEN", previousApiToken);
        restoreProcessEnv(
          "ALCHEMY_BUILD_INHERITED_SENTINEL",
          previousInherited,
        );
      }
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("allows explicitly configured Prisma build credentials", () =>
    Effect.gen(function* () {
      const result = yield* runBuildCommand({
        command: inspectBuildEnvironmentCommand,
        env: {
          PRISMA_SERVICE_TOKEN: "explicit-service-token",
          PRISMA_API_TOKEN: "explicit-api-token",
        },
      });

      expect(JSON.parse(result.stdout)).toEqual({
        serviceToken: "explicit-service-token",
        apiToken: "explicit-api-token",
        inherited: null,
      });
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.live("interrupts a silent build at its configured deadline", () =>
    Effect.gen(function* () {
      const error = yield* runBuildCommand({
        command: "sleep 10",
        timeoutSeconds: 0.05,
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Build command timed out after 0.05 seconds",
      );
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.live("kills descendant processes when a build times out", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-build-process-group-",
      });
      const marker = path.join(root, "descendant-survived");

      yield* runBuildCommand({
        command: `(sleep 0.4; printf survived > ${JSON.stringify(marker)}) & sleep 10`,
        timeoutSeconds: 0.05,
      }).pipe(Effect.flip);
      yield* Effect.sleep("700 millis");

      expect(yield* fs.exists(marker)).toBe(false);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.live("reaps descendants left by a successful build shell", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-build-success-process-group-",
      });
      const marker = path.join(root, "descendant-survived");

      yield* runBuildCommand({
        command: `(sleep 0.4; printf survived > ${JSON.stringify(marker)}) >/dev/null 2>&1 &`,
      });
      yield* Effect.sleep("700 millis");

      expect(yield* fs.exists(marker)).toBe(false);
    }).pipe(Effect.provide(PlatformServices)),
  );
});

describe("Prisma Compute static-site build", () => {
  it.live("packages a prebuilt index without running a command", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-prisma-static-index-",
      });
      yield* fs.writeFileString(path.join(root, "index.html"), "hello static");

      const artifact = yield* runComputeStaticBuild({
        appPath: root,
        outdir: ".",
      });
      yield* Effect.addFinalizer(() => artifact.cleanup);

      yield* withStaticSiteServer(artifact.directory, (origin) =>
        Effect.gen(function* () {
          const response = yield* HttpClient.get(`${origin}/`);
          expect(response.status).toBe(200);
          expect(yield* response.text).toBe("hello static");
        }),
      );

      yield* artifact.cleanup;
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.live("packages and serves static files with SPA fallback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, command } = yield* copyStaticBuildFixture;
      const artifact = yield* runComputeStaticBuild({
        appPath: root,
        command,
        outdir: "dist",
        spa: true,
      });
      yield* Effect.addFinalizer(() => artifact.cleanup);
      const index = yield* fs.readFileString(
        path.join(root, "dist/index.html"),
      );
      const script = yield* fs.readFileString(
        path.join(root, "dist/assets/app.js"),
      );
      const scriptStat = yield* fs.stat(path.join(root, "dist/assets/app.js"));
      const stylesheet = yield* fs.readFileString(
        path.join(root, "dist/assets/index.css"),
      );
      const docs = yield* fs.readFileString(
        path.join(root, "dist/docs/index.html"),
      );

      expect(artifact.requiredFiles).toEqual(["public/index.html"]);
      expect(artifact.entrypoint).toBe("server.mjs");
      expect(artifact.defaultPort).toBe(8080);
      expect(index).toContain("<h1>app shell</h1>");
      expect(script).toMatch(/console\.log\(["'`]asset["'`]\)/);
      expect(
        yield* fs.readFileString(
          path.join(artifact.directory, "public", "index.html"),
        ),
      ).toBe(index);
      expect(yield* fs.exists(path.join(root, "server.mjs"))).toBe(false);

      const archive = yield* createComputeArchive({
        directory: artifact.directory,
        entrypoint: artifact.entrypoint,
        ignore: ["assets/*.map", "*.mjs"],
        ignorePrefix: artifact.archiveIgnorePrefix,
        requiredFiles: artifact.requiredFiles,
      });
      const excludedIndexError = yield* createComputeArchive({
        directory: artifact.directory,
        entrypoint: artifact.entrypoint,
        ignore: ["index.html"],
        ignorePrefix: artifact.archiveIgnorePrefix,
        requiredFiles: artifact.requiredFiles,
      }).pipe(Effect.flip);
      expect(excludedIndexError.message).toContain(
        "Required file not found in compute artifact: public/index.html",
      );
      const extracted = yield* extractStaticArchive(archive);
      expect(yield* fs.exists(path.join(extracted, "server.mjs"))).toBe(true);
      expect(
        yield* fs.exists(path.join(extracted, "public/assets/app.mjs")),
      ).toBe(true);
      expect(
        yield* fs.exists(path.join(extracted, "public/assets/app.js.map")),
      ).toBe(false);

      for (const directory of [artifact.directory, extracted]) {
        yield* withStaticSiteServer(directory, (origin) =>
          Effect.gen(function* () {
            const rootResponse = yield* HttpClient.get(`${origin}/`);
            expect(rootResponse.status).toBe(200);
            expect(rootResponse.headers["content-type"]).toContain("text/html");
            expect(yield* rootResponse.text).toBe(index);

            const assetResponse = yield* HttpClient.get(
              `${origin}/assets/app.js`,
            );
            expect(assetResponse.status).toBe(200);
            expect(assetResponse.headers["content-type"]).toContain(
              "javascript",
            );
            expect(yield* assetResponse.text).toBe(script);

            const cssResponse = yield* HttpClient.get(
              `${origin}/assets/index.css`,
            );
            expect(cssResponse.status).toBe(200);
            expect(cssResponse.headers["content-type"]).toContain("text/css");
            expect(yield* cssResponse.text).toBe(stylesheet);

            const directoryResponse = yield* HttpClient.get(`${origin}/docs/`);
            expect(directoryResponse.status).toBe(200);
            expect(yield* directoryResponse.text).toBe(docs);
            yield* assertDirectoryRedirects(origin);

            const directoryHead = yield* HttpClient.head(`${origin}/docs/`);
            expect(directoryHead.status).toBe(200);
            expect(directoryHead.headers["content-type"]).toContain(
              "text/html",
            );
            expect(yield* directoryHead.text).toBe("");

            const encodedResponse = yield* HttpClient.get(
              `${origin}/docs%20%231.html`,
            );
            expect(encodedResponse.status).toBe(200);
            expect(yield* encodedResponse.text).toBe("encoded asset\n");

            const fallbackResponse = yield* HttpClient.get(
              `${origin}/dashboard/settings`,
            );
            expect(fallbackResponse.status).toBe(200);
            expect(yield* fallbackResponse.text).toBe(index);

            const fallbackHead = yield* HttpClient.head(
              `${origin}/dashboard/settings`,
            );
            expect(fallbackHead.status).toBe(200);
            expect(yield* fallbackHead.text).toBe("");

            const headResponse = yield* HttpClient.head(
              `${origin}/assets/app.js`,
            );
            expect(headResponse.status).toBe(200);
            expect(headResponse.headers["content-length"]).toBe(
              String(scriptStat.size),
            );
            expect(headResponse.headers["content-type"]).toBe(
              assetResponse.headers["content-type"],
            );
            expect(yield* headResponse.text).toBe("");

            const postResponse = yield* HttpClient.post(`${origin}/`);
            expect(postResponse.status).toBe(405);
            expect(postResponse.headers["allow"]).toBe("GET, HEAD");
            expect(yield* postResponse.text).toBe("Method Not Allowed");

            for (const invalidPath of [
              "/..%2Fsecret",
              "/%2e%2e%2fsecret",
              "/%00",
              "/%E0%A4%A",
              "/%ZZ",
            ]) {
              const invalidResponse = yield* HttpClient.get(
                `${origin}${invalidPath}`,
              );
              expect(invalidResponse.status).toBe(400);
              expect(yield* invalidResponse.text).toBe("Bad Request");
            }
          }),
        );
      }

      yield* artifact.cleanup;
      expect(yield* fs.exists(artifact.directory)).toBe(false);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.live("serves a custom root page without enabling SPA fallback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, command } = yield* copyStaticBuildFixture;
      const artifact = yield* runComputeStaticBuild({
        appPath: root,
        command,
        outdir: "dist",
        indexPage: "home.html",
      });
      yield* Effect.addFinalizer(() => artifact.cleanup);
      const docs = yield* fs.readFileString(
        path.join(root, "dist/docs/index.html"),
      );
      expect(artifact.requiredFiles).toEqual(["public/home.html"]);
      const archive = yield* createComputeArchive({
        directory: artifact.directory,
        entrypoint: artifact.entrypoint,
        requiredFiles: artifact.requiredFiles,
      });
      const excludedIndexError = yield* createComputeArchive({
        directory: artifact.directory,
        entrypoint: artifact.entrypoint,
        ignore: ["home.html"],
        ignorePrefix: artifact.archiveIgnorePrefix,
        requiredFiles: artifact.requiredFiles,
      }).pipe(Effect.flip);
      expect(excludedIndexError.message).toContain(
        "Required file not found in compute artifact: public/home.html",
      );
      const extracted = yield* extractStaticArchive(archive);

      for (const directory of [artifact.directory, extracted]) {
        yield* withStaticSiteServer(directory, (origin) =>
          Effect.gen(function* () {
            const rootResponse = yield* HttpClient.get(`${origin}/`);
            expect(rootResponse.status).toBe(200);
            expect(yield* rootResponse.text).toBe("static home\n");

            const rootHead = yield* HttpClient.head(`${origin}/`);
            expect(rootHead.status).toBe(200);
            expect(rootHead.headers["content-length"]).toBe("12");
            expect(yield* rootHead.text).toBe("");

            const directoryResponse = yield* HttpClient.get(`${origin}/docs/`);
            expect(directoryResponse.status).toBe(200);
            expect(yield* directoryResponse.text).toBe(docs);
            yield* assertDirectoryRedirects(origin);

            const missingResponse = yield* HttpClient.get(`${origin}/missing`);
            expect(missingResponse.status).toBe(404);
            expect(yield* missingResponse.text).toBe("Not Found");

            const missingHead = yield* HttpClient.head(`${origin}/missing`);
            expect(missingHead.status).toBe(404);
            expect(yield* missingHead.text).toBe("");
          }),
        );
      }

      yield* artifact.cleanup;
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("scopes archive ignores to the static output", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-static-site-ignore-",
      });
      yield* fs.makeDirectory(path.join(root, "dist", "assets"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(root, "dist", "index.html"),
        "static home",
      );
      yield* fs.writeFileString(
        path.join(root, "dist", "assets", "app.mjs"),
        "app",
      );
      yield* fs.writeFileString(
        path.join(root, "dist", "assets", "app.js.map"),
        "source map",
      );

      const artifact = yield* runComputeStaticBuild({
        appPath: root,
        command: "true",
        outdir: "dist",
      });
      const archive = yield* createComputeArchive({
        directory: artifact.directory,
        entrypoint: artifact.entrypoint,
        ignore: ["assets/*.map", "*.mjs"],
        ignorePrefix: artifact.archiveIgnorePrefix,
        requiredFiles: artifact.requiredFiles,
      }).pipe(Effect.ensuring(artifact.cleanup));
      const tarText = yield* Effect.sync(() =>
        new TextDecoder().decode(gunzipSync(archive)),
      );

      expect(tarText).toContain("bundle/server.mjs");
      expect(tarText).toContain("bundle/public/index.html");
      expect(tarText).toContain("bundle/public/assets/app.mjs");
      expect(tarText).not.toContain("bundle/public/assets/app.js.map");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("rejects unsafe output and index paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-static-site-paths-",
      });

      const outdirError = yield* runComputeStaticBuild({
        appPath: root,
        command: "true",
        outdir: "../dist",
      }).pipe(Effect.flip);
      expect((outdirError as Error).message).toContain(
        "outdir must be a relative path",
      );

      const indexError = yield* runComputeStaticBuild({
        appPath: root,
        command: "true",
        outdir: "dist",
        indexPage: "../index.html",
      }).pipe(Effect.flip);
      expect((indexError as Error).message).toContain(
        "indexPage must be a relative file path",
      );
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("fails when the build output or index page is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-static-site-missing-",
      });

      const outputError = yield* runComputeStaticBuild({
        appPath: root,
        command: "true",
        outdir: "dist",
      }).pipe(Effect.flip);
      expect((outputError as Error).message).toContain(
        "did not produce an output directory",
      );

      yield* fs.makeDirectory(path.join(root, "dist"));
      const indexError = yield* runComputeStaticBuild({
        appPath: root,
        command: "true",
        outdir: "dist",
      }).pipe(Effect.flip);
      expect((indexError as Error).message).toContain(
        "did not produce index.html",
      );
    }).pipe(Effect.provide(PlatformServices)),
  );
});

const assertDirectoryRedirects = Effect.fn(function* (origin: string) {
  const query = "?from=%2Fclient%2Froute&next=%2F%2Fevil.example";
  for (const pathname of ["/docs", "//docs", "/%2Fdocs"]) {
    for (const method of ["GET", "HEAD"] as const) {
      const url = `${origin}${pathname}${query}`;
      const response = yield* (
        method === "GET" ? HttpClient.get(url) : HttpClient.head(url)
      ).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
        }),
      );
      expect(response.status).toBe(301);
      const location = response.headers["location"];
      expect(location).toBe(
        pathname === "/%2Fdocs" ? `/%2Fdocs/${query}` : `/docs/${query}`,
      );
      const target = yield* Effect.sync(() => new URL(location!, origin));
      expect(target.origin).toBe(origin);
      expect(target.search).toBe(query);
      expect(decodeURIComponent(target.pathname).replace(/^\/+/, "/")).toBe(
        "/docs/",
      );
      expect(yield* response.text).toBe("");

      const assetUrl = yield* Effect.sync(
        () => new URL("./style.css", target).href,
      );
      const asset = yield* HttpClient.get(assetUrl);
      expect(asset.status).toBe(200);
      expect(asset.headers["content-type"]).toContain("text/css");
      expect(yield* asset.text).toContain(".directory-marker");
    }
  }
});

const copyStaticBuildFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fixture = yield* path.fromFileUrl(
    new URL("./fixtures/compute-static-build/", import.meta.url),
  );
  const nodeModules = yield* path.fromFileUrl(
    new URL("../../node_modules/", import.meta.url),
  );
  const root = yield* fs.makeTempDirectoryScoped({
    prefix: "alchemy-prisma-static-build-",
  });
  yield* fs.copy(fixture, root);
  yield* fs.symlink(nodeModules, path.join(root, "node_modules"));
  const executable = yield* Effect.sync(() => process.execPath);
  return {
    root,
    command: `${JSON.stringify(executable)} ${JSON.stringify(path.join(nodeModules, "vite/bin/vite.js"))} build`,
  };
});

const extractStaticArchive = Effect.fn(function* (archive: Uint8Array) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({
    prefix: "alchemy-prisma-static-archive-",
  });
  const archivePath = path.join(root, "bundle.tar.gz");
  yield* fs.writeFile(archivePath, archive);
  const handle = yield* spawner.spawn(
    ChildProcess.make("tar", ["-xzf", archivePath, "-C", root], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    }),
  );
  expect(yield* handle.exitCode).toBe(0);
  return path.join(root, "bundle");
});

const withStaticSiteServer = <A, E, R>(
  directory: string,
  use: (origin: string) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner;
      const port = yield* findAvailablePort();
      const executable = yield* Effect.sync(() => process.execPath);
      yield* spawner.spawn(
        ChildProcess.make(executable, ["server.mjs"], {
          cwd: directory,
          env: { PORT: String(port) },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "inherit",
          killSignal: "SIGKILL",
        }),
      );
      const origin = `http://127.0.0.1:${port}`;
      yield* HttpClient.head(`${origin}/`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.void
            : Effect.fail(
                new Error(
                  `Static server readiness returned ${response.status}`,
                ),
              ),
        ),
        Effect.timeout("1 second"),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 10 }),
      );
      return yield* use(origin);
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer));
