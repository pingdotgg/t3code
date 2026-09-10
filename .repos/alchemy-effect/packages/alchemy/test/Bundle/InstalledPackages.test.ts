import {
  hashPackageInstallIdentity,
  installPackages,
  installResolvedPackages,
  matchesPackageRoot,
  normalizeInstallTargets,
  npmInstallArgs,
  npmLockfileArgs,
  npmPlainInstallArgs,
  parsePackageRoot,
  parsePackageRootFromSpecifier,
  resolveInstallTargets,
  resolvePackageInstallIdentity,
} from "@/Bundle/InstalledPackages";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { spawnSync } from "node:child_process";
import { zipCode } from "@/Util/zip";

const integrationEnabled =
  process.env.ALCHEMY_TEST_LAMBDA_EXTERNAL_PACKAGES === "1" &&
  spawnSync("npm", ["--version"], { stdio: "ignore" }).status === 0;

const withLockfileFixture = <A, E, R>(
  options: {
    readonly prefix: string;
    readonly packageJson: unknown;
    readonly lockfileName: string;
    readonly lockfileContent: string;
    readonly workspace?: string;
  },
  use: (context: {
    readonly root: string;
    readonly cwd: string;
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({ prefix: options.prefix });
    const cwd =
      options.workspace === undefined
        ? root
        : path.join(root, options.workspace);
    try {
      if (cwd !== root) yield* fs.makeDirectory(cwd, { recursive: true });
      yield* fs.writeFileString(
        path.join(cwd, "package.json"),
        JSON.stringify(options.packageJson),
      );
      yield* fs.writeFileString(
        path.join(root, options.lockfileName),
        options.lockfileContent,
      );
      return yield* use({ root, cwd, fs, path });
    } finally {
      yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
    }
  });

describe("Lambda external packages", () => {
  it("accepts only package roots, not subpaths", () => {
    expect(parsePackageRoot("sharp")).toBe("sharp");
    expect(parsePackageRoot("@img/tool")).toBe("@img/tool");
    expect(parsePackageRoot("sharp/lib/index.js")).toBeUndefined();
    expect(parsePackageRoot("@img/sharp-linux-arm64/lib")).toBeUndefined();
    expect(parsePackageRoot("node:fs")).toBeUndefined();
    expect(parsePackageRoot("./local.js")).toBeUndefined();
  });

  it("extracts package roots from externalized module ids", () => {
    expect(parsePackageRootFromSpecifier("heic-convert")).toBe("heic-convert");
    expect(parsePackageRootFromSpecifier("heic-convert/lib")).toBe(
      "heic-convert",
    );
    expect(parsePackageRootFromSpecifier("@scope/pkg/subpath")).toBe(
      "@scope/pkg",
    );
    expect(parsePackageRootFromSpecifier("node:fs")).toBeUndefined();
    expect(parsePackageRootFromSpecifier("./local.js")).toBeUndefined();
    expect(parsePackageRootFromSpecifier("")).toBeUndefined();
    expect(parsePackageRootFromSpecifier("@scope")).toBeUndefined();
  });

  it("matches package roots and subpath imports", () => {
    expect(matchesPackageRoot("sharp", "sharp")).toBe(true);
    expect(matchesPackageRoot("sharp/lib/index.js", "sharp")).toBe(true);
    expect(matchesPackageRoot("sharpish", "sharp")).toBe(false);
    expect(matchesPackageRoot("@scope/pkg", "@scope/pkg")).toBe(true);
    expect(matchesPackageRoot("@scope/pkg/sub", "@scope/pkg")).toBe(true);
  });

  it.effect("rejects subpaths in build.install", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(normalizeInstallTargets(["sharp/lib"]));
      expect(error.message).toMatch(/Invalid package name/);
    }),
  );

  it.effect("normalizes and validates install targets", () =>
    Effect.gen(function* () {
      expect(yield* normalizeInstallTargets(["sharp", "pg-native"])).toEqual({
        sharp: "*",
        "pg-native": "*",
      });
      expect(yield* normalizeInstallTargets({ sharp: "^0.33.5" })).toEqual({
        sharp: "^0.33.5",
      });
    }),
  );

  it("targets Linux and the Lambda architecture", () => {
    expect(npmInstallArgs("arm64")).toEqual([
      "ci",
      "--force",
      "--platform=linux",
      "--os=linux",
      "--arch=arm64",
      "--cpu=arm64",
      "--libc=glibc",
    ]);
    expect(npmInstallArgs("x86_64")).toEqual([
      "ci",
      "--force",
      "--platform=linux",
      "--os=linux",
      "--arch=x64",
      "--cpu=x64",
      "--libc=glibc",
    ]);
    expect(npmLockfileArgs("arm64")).toEqual([
      "install",
      "--force",
      "--platform=linux",
      "--os=linux",
      "--arch=arm64",
      "--cpu=arm64",
      "--libc=glibc",
      "--package-lock-only",
      "--ignore-scripts",
    ]);
    expect(npmPlainInstallArgs("arm64")).toEqual([
      "install",
      "--force",
      "--platform=linux",
      "--os=linux",
      "--arch=arm64",
      "--cpu=arm64",
      "--libc=glibc",
    ]);
  });

  it.effect("resolves catalog versions from pnpm-workspace.yaml", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-external-catalog-",
      });

      try {
        yield* fs.writeFileString(
          path.join(root, "pnpm-workspace.yaml"),
          ["packages:", "  - packages/*", "catalog:", "  sharp: ^0.33.5"].join(
            "\n",
          ),
        );
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { sharp: "catalog:" } }),
        );

        const files = yield* installPackages({
          cwd: root,
          install: ["sharp"],
          architecture: "arm64",
          runNpmInstall: (directory) =>
            Effect.gen(function* () {
              const packageJson = JSON.parse(
                yield* fs.readFileString(path.join(directory, "package.json")),
              );
              expect(packageJson.dependencies.sharp).toBe("^0.33.5");
            }),
        });

        expect(files.map((file) => file.path)).toContain("package.json");
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves named catalog versions from pnpm-workspace.yaml", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-external-pnpm-named-catalog-",
      });

      try {
        yield* fs.writeFileString(
          path.join(root, "pnpm-workspace.yaml"),
          [
            "packages:",
            "  - packages/*",
            "catalogs:",
            "  native:",
            "    sharp: ^0.34.5",
          ].join("\n"),
        );
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { sharp: "catalog:native" } }),
        );

        const files = yield* installPackages({
          cwd: root,
          install: ["sharp"],
          architecture: "arm64",
          runNpmInstall: (directory) =>
            Effect.gen(function* () {
              const packageJson = JSON.parse(
                yield* fs.readFileString(path.join(directory, "package.json")),
              );
              expect(packageJson.dependencies.sharp).toBe("^0.34.5");
            }),
        });

        expect(files.map((file) => file.path)).toContain("package.json");
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves catalog versions from Bun workspace metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-external-bun-catalog-",
      });

      try {
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({
            workspaces: {
              packages: ["packages/*"],
              catalogs: {
                native: {
                  sharp: "^0.34.5",
                },
              },
            },
            dependencies: { sharp: "catalog:native" },
          }),
        );

        const files = yield* installPackages({
          cwd: root,
          install: ["sharp"],
          architecture: "arm64",
          runNpmInstall: (directory) =>
            Effect.gen(function* () {
              const packageJson = JSON.parse(
                yield* fs.readFileString(path.join(directory, "package.json")),
              );
              expect(packageJson.dependencies.sharp).toBe("^0.34.5");
            }),
        });

        expect(files.map((file) => file.path)).toContain("package.json");
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to optional and dev dependency versions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-external-dependency-sections-",
      });

      try {
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({
            optionalDependencies: { sharp: "^0.34.5" },
            devDependencies: { "pg-native": "^3.2.0" },
          }),
        );

        const files = yield* installPackages({
          cwd: root,
          install: ["sharp", "pg-native"],
          architecture: "x86_64",
          runNpmInstall: (directory) =>
            Effect.gen(function* () {
              const packageJson = JSON.parse(
                yield* fs.readFileString(path.join(directory, "package.json")),
              );
              expect(packageJson.dependencies).toEqual({
                "pg-native": "^3.2.0",
                sharp: "^0.34.5",
              });
            }),
        });

        expect(files.map((file) => file.path)).toContain("package.json");
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects workspace and file dependency protocols", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-external-incompatible-protocol-",
      });

      try {
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({
            dependencies: {
              sharp: "workspace:*",
              "pg-native": "file:../pg-native",
            },
          }),
        );

        const workspaceError = yield* installPackages({
          cwd: root,
          install: ["sharp"],
          architecture: "arm64",
          runNpmInstall: () => Effect.void,
        }).pipe(Effect.flip);
        expect(workspaceError.message).toContain("workspace:*");

        const fileError = yield* installPackages({
          cwd: root,
          install: ["pg-native"],
          architecture: "arm64",
          runNpmInstall: () => Effect.void,
        }).pipe(Effect.flip);
        expect(fileError.message).toContain("file:../pg-native");
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("installs into an isolated artifact and returns its files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-external-source-",
      });
      let installDirectory: string | undefined;
      const installArgs: Array<ReadonlyArray<string>> = [];
      let artifactPackageJson: unknown;

      try {
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { sharp: "^0.34.5" } }),
        );

        const files = yield* installPackages({
          cwd: root,
          install: ["sharp"],
          architecture: "arm64",
          runNpmInstall: (directory, args) =>
            Effect.gen(function* () {
              installDirectory = directory;
              installArgs.push(args);
              const manifest = yield* fs.readFileString(
                path.join(directory, "package.json"),
              );
              artifactPackageJson = yield* Effect.try(() =>
                JSON.parse(manifest),
              );

              const sharpRoot = path.join(directory, "node_modules", "sharp");
              const sharpBinRoot = path.join(sharpRoot, "bin");
              const binRoot = path.join(directory, "node_modules", ".bin");
              const binaryRoot = path.join(
                directory,
                "node_modules",
                "@img",
                "sharp-linux-arm64",
                "lib",
              );
              const libvipsRoot = path.join(
                directory,
                "node_modules",
                "@img",
                "sharp-libvips-linux-arm64",
                "lib",
              );
              yield* fs.makeDirectory(sharpRoot, { recursive: true });
              yield* fs.makeDirectory(sharpBinRoot, { recursive: true });
              yield* fs.makeDirectory(binRoot, { recursive: true });
              yield* fs.makeDirectory(binaryRoot, { recursive: true });
              yield* fs.makeDirectory(libvipsRoot, { recursive: true });
              yield* fs.writeFileString(
                path.join(sharpRoot, "package.json"),
                JSON.stringify({ name: "sharp", version: "0.34.5" }),
              );
              const executablePath = path.join(sharpBinRoot, "sharp-tool");
              yield* fs.writeFileString(executablePath, "#!/bin/sh\n");
              yield* fs.chmod(executablePath, 0o755);
              yield* fs.symlink(
                "../sharp/bin/sharp-tool",
                path.join(binRoot, "sharp-tool"),
              );
              yield* fs.writeFile(
                path.join(binaryRoot, "sharp.node"),
                new Uint8Array([0, 1, 2, 3]),
              );
              yield* fs.writeFile(
                path.join(libvipsRoot, "libvips.so"),
                new Uint8Array([4, 5, 6, 7]),
              );
              yield* fs.writeFileString(
                path.join(directory, "package-lock.json"),
                "{}",
              );
            }),
        });

        expect(artifactPackageJson).toEqual({
          private: true,
          dependencies: { sharp: "^0.34.5" },
        });
        // No lockfile in the fixture means nothing to pin, so the install is a
        // single plain `npm install` instead of the lockfile-generate + ci pair.
        expect(installArgs).toEqual([npmPlainInstallArgs("arm64")]);
        expect(files.map((file) => file.path)).toEqual(
          expect.arrayContaining([
            "package.json",
            "package-lock.json",
            "node_modules/sharp/package.json",
            "node_modules/sharp/bin/sharp-tool",
            "node_modules/.bin/sharp-tool",
            "node_modules/@img/sharp-linux-arm64/lib/sharp.node",
            "node_modules/@img/sharp-libvips-linux-arm64/lib/libvips.so",
          ]),
        );
        const executable = files.find(
          (file) => file.path === "node_modules/sharp/bin/sharp-tool",
        );
        const symlink = files.find(
          (file) => file.path === "node_modules/.bin/sharp-tool",
        );
        expect(executable?.mode && executable.mode & 0o111).toBe(0o111);
        expect(symlink?.mode && symlink.mode & 0o170000).toBe(0o120000);
        const archive = yield* zipCode(
          "export const handler = () => {};",
          files,
        );
        const zip = yield* Effect.promise(async () => {
          const JSZip = (await import("jszip")).default;
          return JSZip.loadAsync(archive);
        });
        expect(
          zip.file("node_modules/@img/sharp-linux-arm64/lib/sharp.node"),
        ).not.toBeNull();
        expect(
          zip.file(
            "node_modules/@img/sharp-libvips-linux-arm64/lib/libvips.so",
          ),
        ).not.toBeNull();
        const executablePermissions = zip.file(
          "node_modules/sharp/bin/sharp-tool",
        )!.unixPermissions;
        const symlinkPermissions = zip.file(
          "node_modules/.bin/sharp-tool",
        )!.unixPermissions;
        if (
          typeof executablePermissions !== "number" ||
          typeof symlinkPermissions !== "number"
        ) {
          throw new Error("Expected numeric Unix permissions in archive");
        }
        expect(executablePermissions & 0o111).toBe(0o111);
        expect(symlinkPermissions & 0o170000).toBe(0o120000);
        expect(
          yield* Effect.promise(() =>
            zip.file("node_modules/.bin/sharp-tool")!.async("string"),
          ),
        ).toBe("../sharp/bin/sharp-tool");
        expect(installDirectory).toBeDefined();
        expect(yield* fs.exists(installDirectory!)).toBe(false);
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not install package.json dependencies unless requested", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-external-unrequested-",
      });
      let installed = false;

      try {
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { "heic-convert": "^2.1.0" } }),
        );

        const files = yield* installPackages({
          cwd: root,
          architecture: "arm64",
          runNpmInstall: () =>
            Effect.sync(() => {
              installed = true;
            }),
        });

        expect(installed).toBe(false);
        expect(files).toEqual([]);
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns an empty install identity when nothing is requested", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-external-empty-identity-",
      });

      try {
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { sharp: "^0.34.5" } }),
        );
        yield* fs.writeFileString(
          path.join(root, "package-lock.json"),
          "sharp@0.34.5",
        );

        expect(
          yield* resolvePackageInstallIdentity({
            cwd: root,
            requested: {},
          }),
        ).toEqual({ resolved: {}, overrides: {} });
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails when the source package.json is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-external-missing-manifest-",
      });

      try {
        const error = yield* installPackages({
          cwd: root,
          install: ["sharp"],
          architecture: "arm64",
          runNpmInstall: () => Effect.void,
        }).pipe(Effect.flip);
        expect(error.message).toContain(
          `Failed to read package.json for Lambda externals from '${root}'`,
        );
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails when the nearest lockfile cannot be read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-external-lockfile-read-error-",
      });

      try {
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { sharp: "^0.34.5" } }),
        );
        yield* fs.makeDirectory(path.join(root, "package-lock.json"));

        const error = yield* resolvePackageInstallIdentity({
          cwd: root,
          requested: { sharp: "*" },
        }).pipe(Effect.flip);
        expect(error.message).toContain(
          `Failed to read package-manager lockfile for Lambda externals from '${root}'`,
        );
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves catalog versions from a top-level Bun catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-external-bun-top-level-catalog-",
      });

      try {
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({
            workspaces: ["packages/*"],
            catalog: { sharp: "^0.33.5" },
            dependencies: { sharp: "catalog:" },
          }),
        );

        const files = yield* installPackages({
          cwd: root,
          install: ["sharp"],
          architecture: "arm64",
          runNpmInstall: (directory) =>
            Effect.gen(function* () {
              const packageJson = JSON.parse(
                yield* fs.readFileString(path.join(directory, "package.json")),
              );
              expect(packageJson.dependencies.sharp).toBe("^0.33.5");
            }),
        });

        expect(files.map((file) => file.path)).toContain("package.json");
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "resolves catalog versions from manifest catalogs with package-only workspaces",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-external-bun-workspace-packages-only-",
        });

        try {
          yield* fs.writeFileString(
            path.join(root, "package.json"),
            JSON.stringify({
              workspaces: { packages: ["packages/*"] },
              catalog: { sharp: "^0.34.5" },
              dependencies: { sharp: "catalog:" },
            }),
          );

          const files = yield* installPackages({
            cwd: root,
            install: ["sharp"],
            architecture: "arm64",
            runNpmInstall: (directory) =>
              Effect.gen(function* () {
                const packageJson = JSON.parse(
                  yield* fs.readFileString(
                    path.join(directory, "package.json"),
                  ),
                );
                expect(packageJson.dependencies.sharp).toBe("^0.34.5");
              }),
          });

          expect(files.map((file) => file.path)).toContain("package.json");
        } finally {
          yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails when a catalog reference cannot be resolved", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-external-unresolved-catalog-",
      });

      try {
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { sharp: "catalog:" } }),
        );

        const error = yield* resolveInstallTargets({
          cwd: root,
          requested: { sharp: "*" },
        }).pipe(Effect.flip);
        expect(error.message).toContain(
          "Could not resolve catalog version for 'sharp'",
        );
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails when a pnpm catalog entry is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-external-missing-pnpm-catalog-entry-",
      });

      try {
        yield* fs.writeFileString(
          path.join(root, "pnpm-workspace.yaml"),
          ["packages:", "  - packages/*", "catalog:", "  other: ^1.0.0"].join(
            "\n",
          ),
        );
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { sharp: "catalog:" } }),
        );

        const error = yield* resolveInstallTargets({
          cwd: root,
          requested: { sharp: "*" },
        }).pipe(Effect.flip);
        expect(error.message).toContain(
          "Could not resolve catalog version for 'sharp' (catalog:)",
        );
        expect(error.message).toContain("pnpm-workspace.yaml");
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("omits lockfile fingerprints when no lockfile exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-external-no-lockfile-",
      });

      try {
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { sharp: "^0.34.5" } }),
        );

        expect(
          yield* resolvePackageInstallIdentity({
            cwd: root,
            requested: { sharp: "*" },
          }),
        ).toEqual({
          resolved: { sharp: "^0.34.5" },
          overrides: {},
          lockfile: undefined,
        });
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails when a Bun workspace catalog entry is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-external-missing-bun-catalog-entry-",
      });

      try {
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({
            workspaces: {
              packages: ["packages/*"],
              catalogs: {
                native: {
                  other: "^1.0.0",
                },
              },
            },
            dependencies: { sharp: "catalog:native" },
          }),
        );

        const error = yield* resolveInstallTargets({
          cwd: root,
          requested: { sharp: "*" },
        }).pipe(Effect.flip);
        expect(error.message).toContain(
          "Could not resolve catalog version for 'sharp' (catalog:native)",
        );
        expect(error.message).toContain("package.json");
      } finally {
        yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  describe.sequential("npm install failures", () => {
    it.effect(
      "fails when npm is missing from PATH",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectory({
            prefix: "alchemy-external-missing-npm-",
          });
          const originalPath = process.env.PATH;

          try {
            process.env.PATH = "";
            yield* fs.writeFileString(
              path.join(root, "package.json"),
              JSON.stringify({ dependencies: { sharp: "^0.34.5" } }),
            );

            const error = yield* installResolvedPackages({
              resolved: { sharp: "^0.34.5" },
              architecture: "arm64",
            }).pipe(Effect.flip);
            expect(error.message).toContain(
              "Failed to run 'npm install' for build.install:",
            );
            expect(error.message).toMatch(/NotFound|ENOENT/);
          } finally {
            process.env.PATH = originalPath;
            yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
          }
        }).pipe(Effect.provide(NodeServices.layer)),
      // Blanking process.env.PATH is process-global: every concurrently
      // running test that spawns a child process would fail with ENOENT.
      // `exclusive` takes the runner's whole-process write lock.
      { exclusive: true },
    );

    it.effect(
      "fails when npm install exits non-zero",
      () =>
        Effect.gen(function* () {
          const error = yield* installResolvedPackages({
            resolved: {
              "alchemy-nonexistent-external-package-xyz": "1.0.0",
            },
            architecture: "arm64",
          }).pipe(Effect.flip);
          expect(error.message).toMatch(
            /npm install for build\.install failed with exit code \d+:/,
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      { timeout: 120_000 },
    );
  });

  // `chmod 0o000` cannot make a directory unreadable on Windows, so the
  // failure under test is unreproducible there.
  it.effect.skipIf(process.platform === "win32")(
    "fails when installed package files cannot be read",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-external-artifact-read-error-",
        });

        try {
          yield* fs.writeFileString(
            path.join(root, "package.json"),
            JSON.stringify({ dependencies: { sharp: "^0.34.5" } }),
          );

          const error = yield* installPackages({
            cwd: root,
            install: ["sharp"],
            architecture: "arm64",
            runNpmInstall: (directory, args) =>
              Effect.gen(function* () {
                if (
                  args[0] === "install" &&
                  args.includes("--package-lock-only")
                )
                  return;
                yield* fs.writeFileString(
                  path.join(directory, "package.json"),
                  JSON.stringify({
                    private: true,
                    dependencies: { sharp: "^0.34.5" },
                  }),
                );
                yield* fs.writeFileString(
                  path.join(directory, "package-lock.json"),
                  "{}",
                );
                yield* fs.chmod(directory, 0o000);
              }),
          }).pipe(Effect.flip);
          expect(error.message).toBe(
            "Failed to read installed Lambda external packages",
          );
        } finally {
          yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "pins requested packages to the versions in supported lockfiles",
    () =>
      Effect.gen(function* () {
        const fixtures = [
          {
            name: "package-lock.json",
            content: JSON.stringify({
              name: "fixture",
              lockfileVersion: 3,
              packages: {
                "": { dependencies: { sharp: "^0.34.0" } },
                "node_modules/sharp": {
                  version: "0.34.5",
                  dependencies: { semver: "^7.0.0" },
                },
                "node_modules/semver": { version: "7.7.3" },
              },
            }),
          },
          {
            name: "package-lock.json",
            content: JSON.stringify({
              lockfileVersion: 1,
              dependencies: {
                sharp: {
                  version: "0.34.5",
                  requires: { semver: "^7.0.0" },
                },
                semver: { version: "7.7.3" },
              },
            }),
          },
          {
            name: "pnpm-lock.yaml",
            content: [
              "lockfileVersion: '9.0'",
              "importers:",
              "  .:",
              "    dependencies:",
              "      sharp:",
              "        specifier: ^0.34.0",
              "        version: 0.34.5",
              "snapshots:",
              "  sharp@0.34.5:",
              "    dependencies:",
              "      semver: 7.7.3",
              "  semver@7.7.3: {}",
            ].join("\n"),
          },
          {
            name: "bun.lock",
            content: [
              "{",
              "  // Bun lockfiles use JSONC.",
              '  "lockfileVersion": 1,',
              '  "workspaces": {',
              '    "": { "dependencies": { "sharp": "^0.34.0" } },',
              "  },",
              '  "packages": {',
              '    "sharp": ["sharp@0.34.5", "", { "dependencies": { "semver": "^7.0.0" } }],',
              '    "semver": ["semver@7.7.3", "", {}],',
              "  },",
              "}",
            ].join("\n"),
          },
          {
            name: "yarn.lock",
            content: [
              "# yarn lockfile v1",
              "",
              "sharp@^0.34.0:",
              '  version "0.34.5"',
              '  resolved "https://registry.yarnpkg.com/sharp/-/sharp-0.34.5.tgz"',
              "  dependencies:",
              '    semver "^7.0.0"',
              "semver@^7.0.0:",
              '  version "7.7.3"',
            ].join("\n"),
          },
          {
            name: "yarn.lock",
            content: [
              '"sharp@npm:^0.34.0":',
              "  version: 0.34.5",
              '  resolution: "sharp@npm:0.34.5"',
              "  dependencies:",
              '    semver: "npm:^7.0.0"',
              '"semver@npm:^7.0.0":',
              "  version: 7.7.3",
              '  resolution: "semver@npm:7.7.3"',
            ].join("\n"),
          },
          {
            // v1 with quoted multi-selector entry keys and quoted pair keys.
            name: "yarn.lock",
            content: [
              "# yarn lockfile v1",
              "",
              '"sharp@^0.34.0", "sharp@~0.34.5":',
              '  version "0.34.5"',
              '  resolved "https://registry.yarnpkg.com/sharp/-/sharp-0.34.5.tgz#abc123"',
              "  dependencies:",
              '    "semver" "^7.0.0"',
              '"semver@^7.0.0", semver@^7.5.0:',
              '  version "7.7.3"',
            ].join("\n"),
          },
        ] as const;

        for (const fixture of fixtures) {
          yield* withLockfileFixture(
            {
              prefix: `alchemy-external-pinned-${fixture.name}-`,
              packageJson: { dependencies: { sharp: "^0.34.0" } },
              lockfileName: fixture.name,
              lockfileContent: fixture.content,
            },
            ({ cwd }) =>
              Effect.gen(function* () {
                const identity = yield* resolvePackageInstallIdentity({
                  cwd,
                  requested: { sharp: "*" },
                });
                expect(identity.resolved, fixture.name).toEqual({
                  sharp: "0.34.5",
                });
                expect(identity.overrides, fixture.name).toEqual({
                  "sharp@0.34.5": { semver: "7.7.3" },
                });
              }),
          );
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "does not replace an explicit install version with a different lock entry",
    () =>
      withLockfileFixture(
        {
          prefix: "alchemy-external-explicit-version-",
          packageJson: { dependencies: { sharp: "^0.34.0" } },
          lockfileName: "package-lock.json",
          lockfileContent: JSON.stringify({
            name: "fixture",
            lockfileVersion: 3,
            packages: {
              "": { dependencies: { sharp: "^0.34.0" } },
              "node_modules/sharp": { version: "0.34.5" },
            },
          }),
        },
        ({ cwd }) =>
          Effect.gen(function* () {
            expect(
              yield* resolveInstallTargets({
                cwd,
                requested: { sharp: "0.33.5" },
              }),
            ).toEqual({ sharp: "0.33.5" });
          }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "pins aliases and transitive dependency edges from package-lock.json",
    () =>
      withLockfileFixture(
        {
          prefix: "alchemy-external-package-lock-plan-",
          packageJson: {
            dependencies: {
              alias: "npm:real@^1.0.0",
              parent: "^1.0.0",
            },
          },
          lockfileName: "package-lock.json",
          lockfileContent: JSON.stringify({
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: {
                  alias: "npm:real@^1.0.0",
                  parent: "^1.0.0",
                },
              },
              "node_modules/alias": {
                name: "real",
                version: "1.2.3",
                dependencies: { leaf: "^2.0.0" },
              },
              "node_modules/parent": {
                version: "1.0.0",
                dependencies: { leaf: "^2.0.0" },
              },
              "node_modules/leaf": { version: "2.4.0" },
            },
          }),
        },
        ({ cwd }) =>
          Effect.gen(function* () {
            const identity = yield* resolvePackageInstallIdentity({
              cwd,
              requested: { alias: "*", parent: "*" },
            });
            expect(identity.resolved).toEqual({
              alias: "npm:real@1.2.3",
              parent: "1.0.0",
            });
            expect(identity.overrides).toEqual({
              "real@1.2.3": { leaf: "2.4.0" },
              "parent@1.0.0": { leaf: "2.4.0" },
            });
          }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a stale Bun importer entry", () =>
    withLockfileFixture(
      {
        prefix: "alchemy-external-stale-bun-lock-",
        packageJson: { dependencies: { sharp: "^0.35.0" } },
        lockfileName: "bun.lock",
        lockfileContent: JSON.stringify({
          lockfileVersion: 1,
          workspaces: {
            "": { dependencies: { sharp: "^0.34.0" } },
          },
          packages: { sharp: ["sharp@0.34.5", "", {}] },
        }),
      },
      ({ cwd }) =>
        Effect.gen(function* () {
          const error = yield* resolveInstallTargets({
            cwd,
            requested: { sharp: "*" },
          }).pipe(Effect.flip);
          expect(error.message).toContain("Could not resolve a locked version");
        }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves Bun packages for the current workspace importer", () =>
    withLockfileFixture(
      {
        prefix: "alchemy-external-bun-importer-",
        workspace: "packages/app",
        packageJson: { dependencies: { sharp: "^0.35.0" } },
        lockfileName: "bun.lock",
        lockfileContent: JSON.stringify({
          lockfileVersion: 1,
          workspaces: {
            "packages/app": {
              name: "app",
              dependencies: { sharp: "^0.35.0" },
            },
          },
          packages: {
            sharp: ["sharp@0.34.5", "", {}],
            "app/sharp": ["sharp@0.35.1", "", {}],
          },
        }),
      },
      ({ cwd }) =>
        Effect.gen(function* () {
          expect(
            yield* resolveInstallTargets({
              cwd,
              requested: { sharp: "*" },
            }),
          ).toEqual({ sharp: "0.35.1" });
        }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves context-specific Bun dependency resolutions", () =>
    withLockfileFixture(
      {
        prefix: "alchemy-external-bun-context-",
        packageJson: { dependencies: { root: "^1.0.0" } },
        lockfileName: "bun.lock",
        lockfileContent: JSON.stringify({
          lockfileVersion: 1,
          workspaces: {
            "": { dependencies: { root: "^1.0.0" } },
          },
          packages: {
            root: [
              "root@1.0.0",
              "",
              { dependencies: { left: "^1", right: "^1" } },
            ],
            "root/left": ["left@1.0.0", "", { dependencies: { shared: "^1" } }],
            "root/right": [
              "right@1.0.0",
              "",
              { dependencies: { shared: "^1" } },
            ],
            "root/left/shared": [
              "shared@1.0.0",
              "",
              { dependencies: { leaf: "^1" } },
            ],
            "root/right/shared": [
              "shared@1.0.0",
              "",
              { dependencies: { leaf: "^1" } },
            ],
            "root/left/shared/leaf": ["leaf@1.0.0", "", {}],
            "root/right/shared/leaf": ["leaf@2.0.0", "", {}],
          },
        }),
      },
      ({ cwd }) =>
        Effect.gen(function* () {
          const identity = yield* resolvePackageInstallIdentity({
            cwd,
            requested: { root: "*" },
          });
          // `shared` resolves uniquely under the root so one flat rule covers
          // it; only the divergent `leaf` needs per-branch nesting.
          expect(identity.overrides).toEqual({
            "root@1.0.0": {
              left: { ".": "1.0.0", leaf: "1.0.0" },
              right: { ".": "1.0.0", leaf: "2.0.0" },
              shared: "1.0.0",
            },
          });
        }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps overrides flat and compact for diamond-shaped graphs",
    () => {
      // 16 levels of diamonds = 2^16 distinct paths. A path-enumerating walk
      // would take minutes and emit megabytes; the deduplicated walk must emit
      // one flat rule per package.
      const levels = 16;
      const packages: Record<string, unknown> = {
        "": { dependencies: { root: "^1.0.0" } },
        "node_modules/root": {
          version: "1.0.0",
          dependencies: { a1: "^1.0.0", b1: "^1.0.0" },
        },
      };
      for (let i = 1; i <= levels; i++) {
        const dependencies =
          i === levels
            ? {}
            : { [`a${i + 1}`]: "^1.0.0", [`b${i + 1}`]: "^1.0.0" };
        packages[`node_modules/a${i}`] = { version: "1.0.0", dependencies };
        packages[`node_modules/b${i}`] = { version: "1.0.0", dependencies };
      }
      return withLockfileFixture(
        {
          prefix: "alchemy-external-diamond-",
          packageJson: { dependencies: { root: "^1.0.0" } },
          lockfileName: "package-lock.json",
          lockfileContent: JSON.stringify({ lockfileVersion: 3, packages }),
        },
        ({ cwd }) =>
          Effect.gen(function* () {
            const identity = yield* resolvePackageInstallIdentity({
              cwd,
              requested: { root: "*" },
            });
            const rootOverrides = identity.overrides["root@1.0.0"];
            expect(typeof rootOverrides).toBe("object");
            expect(Object.keys(rootOverrides as object)).toHaveLength(
              levels * 2,
            );
            expect(
              Object.values(rootOverrides as Record<string, unknown>).every(
                (spec) => spec === "1.0.0",
              ),
            ).toBe(true);
          }),
      ).pipe(Effect.provide(NodeServices.layer));
    },
  );

  it.effect("disambiguates pnpm peer-variant resolutions without failing", () =>
    withLockfileFixture(
      {
        prefix: "alchemy-external-pnpm-peer-variants-",
        packageJson: { dependencies: { root: "^1.0.0" } },
        lockfileName: "pnpm-lock.yaml",
        lockfileContent: [
          "lockfileVersion: '9.0'",
          "importers:",
          "  .:",
          "    dependencies:",
          "      root:",
          "        specifier: ^1.0.0",
          "        version: 1.0.0",
          "snapshots:",
          "  root@1.0.0:",
          "    dependencies:",
          "      m1: 1.0.0",
          "      m2: 1.0.0",
          "  m1@1.0.0:",
          "    dependencies:",
          "      p: 1.0.0(x@1.0.0)",
          "  m2@1.0.0:",
          "    dependencies:",
          "      p: 1.0.0(x@2.0.0)",
          "  p@1.0.0(x@1.0.0):",
          "    dependencies:",
          "      x: 1.0.0",
          "  p@1.0.0(x@2.0.0):",
          "    dependencies:",
          "      x: 2.0.0",
          "  x@1.0.0: {}",
          "  x@2.0.0: {}",
        ].join("\n"),
      },
      ({ cwd }) =>
        Effect.gen(function* () {
          const identity = yield* resolvePackageInstallIdentity({
            cwd,
            requested: { root: "*" },
          });
          expect(identity.overrides).toEqual({
            "root@1.0.0": {
              m1: { ".": "1.0.0", x: "1.0.0" },
              m2: { ".": "1.0.0", x: "2.0.0" },
              p: "1.0.0",
            },
          });
        }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "parses bun.lock JSONC with comments, trailing commas, and tricky strings",
    () =>
      withLockfileFixture(
        {
          prefix: "alchemy-external-bun-jsonc-",
          packageJson: { dependencies: { weird: "^1.0.0" } },
          lockfileName: "bun.lock",
          lockfileContent: [
            "{",
            "  /* block",
            "     comment */",
            '  "lockfileVersion": 1,',
            '  "workspaces": {',
            '    "": { "dependencies": { "weird": "^1.0.0" } }, // line comment',
            "  },",
            '  "packages": {',
            '    "weird": ["weird@1.2.3", "", { "bin": { "weird,]": "cli,}.js" } }],',
            "  },",
            "}",
          ].join("\n"),
        },
        ({ cwd }) =>
          Effect.gen(function* () {
            expect(
              yield* resolveInstallTargets({
                cwd,
                requested: { weird: "*" },
              }),
            ).toEqual({ weird: "1.2.3" });
          }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "includes package-manager lockfiles in the external package identity",
    () =>
      Effect.gen(function* () {
        const lockfileContent = (
          lockfileName:
            | "bun.lock"
            | "package-lock.json"
            | "pnpm-lock.yaml"
            | "yarn.lock",
          version: string,
        ) => {
          switch (lockfileName) {
            case "bun.lock":
              return JSON.stringify({
                lockfileVersion: 1,
                workspaces: {
                  "": { dependencies: { sharp: "^0.34.5" } },
                },
                packages: { sharp: [`sharp@${version}`, "", {}] },
              });
            case "package-lock.json":
              return JSON.stringify({
                lockfileVersion: 3,
                packages: {
                  "": { dependencies: { sharp: "^0.34.5" } },
                  "node_modules/sharp": { version },
                },
              });
            case "pnpm-lock.yaml":
              return [
                "lockfileVersion: '9.0'",
                "importers:",
                "  .:",
                "    dependencies:",
                "      sharp:",
                "        specifier: ^0.34.5",
                `        version: ${version}`,
              ].join("\n");
            case "yarn.lock":
              return [
                "# yarn lockfile v1",
                "",
                `sharp@^0.34.5:`,
                `  version "${version}"`,
              ].join("\n");
          }
        };

        for (const lockfileName of [
          "bun.lock",
          "package-lock.json",
          "pnpm-lock.yaml",
          "yarn.lock",
        ] as const) {
          yield* withLockfileFixture(
            {
              prefix: "alchemy-external-lockfile-",
              packageJson: { dependencies: { sharp: "^0.34.5" } },
              lockfileName,
              lockfileContent: lockfileContent(lockfileName, "0.34.5"),
            },
            ({ cwd, fs, path }) =>
              Effect.gen(function* () {
                const first = yield* resolvePackageInstallIdentity({
                  cwd,
                  requested: { sharp: "*" },
                });
                const firstHash = yield* hashPackageInstallIdentity({
                  bundleHash: "bundle",
                  identity: first,
                  architecture: "arm64",
                });

                yield* fs.writeFileString(
                  path.join(cwd, lockfileName),
                  lockfileContent(lockfileName, "0.34.6"),
                );

                const second = yield* resolvePackageInstallIdentity({
                  cwd,
                  requested: { sharp: "*" },
                });
                const secondHash = yield* hashPackageInstallIdentity({
                  bundleHash: "bundle",
                  identity: second,
                  architecture: "arm64",
                });

                expect(first.resolved).not.toEqual(second.resolved);
                expect(first.lockfile?.name).toBe(lockfileName);
                expect(second.lockfile?.name).toBe(lockfileName);
                expect(first.lockfile?.hash).not.toBe(second.lockfile?.hash);
                expect(firstHash).not.toBe(secondHash);
              }),
          );
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not fall back to node_modules for an invalid bun.lockb", () =>
    withLockfileFixture(
      {
        prefix: "alchemy-external-invalid-lockb-",
        packageJson: { dependencies: { sharp: "^0.34.5" } },
        lockfileName: "bun.lockb",
        lockfileContent: "invalid",
      },
      ({ cwd, fs, path }) =>
        Effect.gen(function* () {
          const installedPackage = path.join(cwd, "node_modules", "sharp");
          yield* fs.makeDirectory(installedPackage, { recursive: true });
          yield* fs.writeFileString(
            path.join(installedPackage, "package.json"),
            JSON.stringify({ name: "sharp", version: "999.0.0" }),
          );

          const error = yield* resolveInstallTargets({
            cwd,
            requested: { sharp: "*" },
          }).pipe(Effect.flip);
          expect(error.message).toContain(
            "Failed to inspect legacy Bun lockfile",
          );
        }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe.skipIf(!integrationEnabled)(
  "Lambda external packages integration",
  () => {
    it.effect(
      "npm-installs aliases with pinned transitive dependencies",
      () =>
        Effect.gen(function* () {
          const files = yield* installResolvedPackages({
            resolved: { odd: "npm:is-odd@3.0.1" },
            overrides: {
              "is-odd@3.0.1": { "is-number": "6.0.0" },
            },
            architecture: "arm64",
          });
          const aliasManifest = files.find(
            (file) => file.path === "node_modules/odd/package.json",
          );
          const transitiveManifest = files.find(
            (file) =>
              file.path === "node_modules/is-number/package.json" ||
              file.path ===
                "node_modules/odd/node_modules/is-number/package.json",
          );
          expect(aliasManifest).toBeDefined();
          expect(transitiveManifest).toBeDefined();
          const decoder = new TextDecoder();
          const alias = yield* Effect.try(() =>
            JSON.parse(decoder.decode(aliasManifest?.content)),
          );
          const transitive = yield* Effect.try(() =>
            JSON.parse(decoder.decode(transitiveManifest?.content)),
          );
          expect(alias.name).toBe("is-odd");
          expect(alias.version).toBe("3.0.1");
          expect(transitive.version).toBe("6.0.0");
        }).pipe(Effect.provide(NodeServices.layer)),
      { timeout: 120_000 },
    );

    it.effect(
      "npm-installs sharp with linux arm64 native binaries",
      () =>
        withLockfileFixture(
          {
            prefix: "alchemy-external-sharp-",
            packageJson: { dependencies: { sharp: "^0.33.5" } },
            lockfileName: "package-lock.json",
            lockfileContent: JSON.stringify({
              lockfileVersion: 3,
              packages: {
                "": { dependencies: { sharp: "^0.33.5" } },
                "node_modules/sharp": {
                  version: "0.33.5",
                  dependencies: { semver: "^7.5.4" },
                },
                "node_modules/semver": { version: "7.7.3" },
              },
            }),
          },
          ({ cwd }) =>
            Effect.gen(function* () {
              const files = yield* installPackages({
                cwd,
                install: ["sharp"],
                architecture: "arm64",
              });

              const paths = files.map((file) => file.path);
              expect(paths).toContain("node_modules/sharp/package.json");
              expect(
                paths.some((filePath) =>
                  filePath.includes(
                    "node_modules/@img/sharp-linux-arm64/lib/sharp-linux-arm64.node",
                  ),
                ),
              ).toBe(true);
              expect(
                paths.some((filePath) =>
                  filePath.includes(
                    "node_modules/@img/sharp-libvips-linux-arm64/lib/libvips",
                  ),
                ),
              ).toBe(true);
            }),
        ).pipe(Effect.provide(NodeServices.layer)),
      { timeout: 120_000 },
    );
  },
);
