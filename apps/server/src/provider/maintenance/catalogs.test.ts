import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  canonicalPath,
  type InstallationContext,
  type MaintenanceProbeResult,
} from "./definition.ts";
import {
  makeProviderInstallationCatalog,
  parseWingetPortableArp,
  parseWingetSources,
} from "./catalogs.ts";
import { resolveInstallation } from "./resolver.ts";

const provider = ProviderDriverKind.make("codex");
const catalog = makeProviderInstallationCatalog({
  provider,
  packageName: "@openai/codex",
  executableName: "codex",
  homebrewFormula: "codex",
  native: null,
  instructionsUrl: "https://developers.openai.com/codex/cli/",
  wingetPackageId: "OpenAI.Codex",
});

it("preserves valid backslashes in POSIX filenames", () => {
  expect(canonicalPath("/tmp/provider\\name", "linux")).toBe("/tmp/provider\\name");
});

function context(input: {
  readonly binaryPath: string;
  readonly resolvedCommandPath: string;
  readonly realCommandPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly files?: Readonly<Record<string, string>>;
  readonly commands?: Readonly<Record<string, string>>;
  readonly probes?: Readonly<Record<string, MaintenanceProbeResult>>;
  readonly realPaths?: Readonly<Record<string, string>>;
  readonly textFileReads?: Array<{ readonly path: string; readonly maxBytes?: number }>;
}): InstallationContext {
  const files = new Map(
    Object.entries(input.files ?? {}).map(([path, value]) => [
      path.replaceAll("\\", "/").toLowerCase(),
      value,
    ]),
  );
  return {
    provider,
    packageName: "@openai/codex",
    binaryPath: input.binaryPath,
    isBareCommand: !input.binaryPath.includes("/") && !input.binaryPath.includes("\\"),
    resolvedCommandPath: input.resolvedCommandPath,
    realCommandPath: input.realCommandPath ?? input.resolvedCommandPath,
    environment: input.environment ?? { PATH: "test-path" },
    platform: input.platform ?? "linux",
    readTextFile: (path, maxBytes) => {
      input.textFileReads?.push({ path, ...(maxBytes === undefined ? {} : { maxBytes }) });
      const value = files.get(path.replaceAll("\\", "/").toLowerCase()) ?? null;
      return Effect.succeed(
        value !== null && maxBytes !== undefined && Buffer.byteLength(value) > maxBytes
          ? null
          : value,
      );
    },
    realPath: (path) =>
      Effect.succeed(input.realPaths?.[path.replaceAll("\\", "/").toLowerCase()] ?? path),
    resolveCommand: (command) => Effect.succeed(input.commands?.[command] ?? null),
    run: (executable, args) =>
      Effect.succeed(input.probes?.[`${executable} ${args.join(" ")}`] ?? null),
  };
}

it.effect("keeps native installation identity stable across versioned executable targets", () => {
  const nativeCatalog = makeProviderInstallationCatalog({
    provider,
    packageName: "@openai/codex",
    executableName: "codex",
    homebrewFormula: null,
    native: {
      label: "Managed by native installer",
      updateArgs: ["update"],
      ownsPath: (path) => path.includes("/.codex/packages/standalone/releases/"),
      identityRoot: (path) => {
        const marker = "/.codex/packages/standalone/releases/";
        const markerIndex = path.indexOf(marker);
        return markerIndex < 0 ? null : path.slice(0, markerIndex + marker.length - 1);
      },
    },
    instructionsUrl: "https://developers.openai.com/codex/cli/",
  });
  const resolvedCommandPath = "/home/test/.local/bin/codex";
  return Effect.gen(function* () {
    const before = yield* resolveInstallation(
      context({
        binaryPath: "codex",
        resolvedCommandPath,
        realCommandPath:
          "/home/test/.codex/packages/standalone/releases/1.0.0-x86_64-unknown-linux-musl/bin/codex",
      }),
      nativeCatalog,
    );
    const after = yield* resolveInstallation(
      context({
        binaryPath: "codex",
        resolvedCommandPath,
        realCommandPath:
          "/home/test/.codex/packages/standalone/releases/1.1.0-x86_64-unknown-linux-musl/bin/codex",
      }),
      nativeCatalog,
    );

    expect(before.identityKey).toBe(after.identityKey);
    expect(before.lockKey).toBe(after.lockKey);
    expect(before.update?.executable).toContain("/releases/1.0.0-");
    expect(after.update?.executable).toContain("/releases/1.1.0-");
  });
});

it.effect("proves Scoop ownership from the resolved shim and uses that Scoop and bucket", () => {
  const root = "C:/Users/test/scoop";
  const shim = `${root}/shims/codex.exe`;
  const scoop = `${root}/shims/scoop.ps1`;
  return resolveInstallation(
    context({
      binaryPath: "codex",
      resolvedCommandPath: shim,
      platform: "win32",
      commands: { scoop },
      files: {
        [`${root}/shims/codex.shim`]: `path = "${root}/apps/codex-nightly/current/codex.exe"`,
        [`${root}/apps/codex-nightly/current/install.json`]: JSON.stringify({ bucket: "custom" }),
        [`${root}/apps/codex-nightly/current/manifest.json`]: JSON.stringify({ version: "1.2.3" }),
        [`${root}/buckets/custom/bucket/codex-nightly.json`]: JSON.stringify({ version: "1.3.0" }),
      },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Managed by Scoop",
        ownershipVerified: true,
        currentVersion: "1.2.3",
        latestVersion: "1.3.0",
        update: {
          executable: scoop,
          args: ["update", "custom/codex-nightly"],
        },
      });
    }),
  );
});

it.effect("proves a custom global Scoop root from Scoop configuration", () => {
  const userRoot = "C:/Users/test/scoop";
  const globalRoot = "D:/Shared/ScoopGlobal";
  const shim = `${globalRoot}/shims/codex.exe`;
  const scoop = `${userRoot}/shims/scoop.ps1`;
  return resolveInstallation(
    context({
      binaryPath: "codex",
      resolvedCommandPath: shim,
      platform: "win32",
      commands: { scoop },
      files: {
        [`${globalRoot}/shims/codex.shim`]: `path = "${globalRoot}/apps/codex/current/codex.exe"`,
        [`${globalRoot}/apps/codex/current/install.json`]: JSON.stringify({ bucket: "main" }),
        [`${globalRoot}/apps/codex/current/manifest.json`]: JSON.stringify({ version: "1.2.3" }),
        [`${userRoot}/buckets/main/bucket/codex.json`]: JSON.stringify({ version: "1.3.0" }),
      },
      probes: {
        [`${scoop} config global_path`]: {
          stdout: globalRoot,
          stderr: "",
          exitCode: 0,
        },
      },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Managed by Scoop",
        ownershipVerified: true,
        update: {
          executable: scoop,
          args: ["update", "main/codex", "--global"],
        },
      });
    }),
  );
});

it.effect("treats SCOOP_GLOBAL as authoritative over Scoop configuration", () => {
  const userRoot = "C:/Users/test/scoop";
  const observedGlobalRoot = "D:/Shared/ScoopGlobal";
  const environmentGlobalRoot = "E:/Authoritative/ScoopGlobal";
  const shim = `${observedGlobalRoot}/shims/codex.exe`;
  const scoop = `${userRoot}/shims/scoop.ps1`;
  return resolveInstallation(
    context({
      binaryPath: "codex",
      resolvedCommandPath: shim,
      platform: "win32",
      environment: { PATH: "test-path", SCOOP_GLOBAL: environmentGlobalRoot },
      commands: { scoop },
      files: {
        [`${observedGlobalRoot}/shims/codex.shim`]: `path = "${observedGlobalRoot}/apps/codex/current/codex.exe"`,
        [`${observedGlobalRoot}/apps/codex/current/install.json`]: JSON.stringify({
          bucket: "main",
        }),
        [`${observedGlobalRoot}/apps/codex/current/manifest.json`]: JSON.stringify({
          version: "1.2.3",
        }),
      },
      probes: {
        [`${scoop} config global_path`]: {
          stdout: observedGlobalRoot,
          stderr: "",
          exitCode: 0,
        },
      },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Unknown installation — verification failed",
        ownershipVerified: false,
        update: null,
      });
    }),
  );
});

it.effect("keeps an unknown bare command manual-only", () => {
  return resolveInstallation(
    context({
      binaryPath: "codex",
      resolvedCommandPath: "/custom/bin/codex",
      commands: { npm: "/usr/local/bin/npm" },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Unknown installation",
        ownershipVerified: false,
        update: null,
      });
    }),
  );
});

it.effect("pins npm updates to the verified package prefix", () => {
  const packagePrefix = "/opt/node-a";
  const packageRoot = `${packagePrefix}/lib/node_modules/@openai/codex`;
  const npm = "/opt/node-b/bin/npm";
  return resolveInstallation(
    context({
      binaryPath: "codex",
      resolvedCommandPath: `${packagePrefix}/bin/codex`,
      realCommandPath: `${packageRoot}/bin/codex.js`,
      commands: { npm },
      files: {
        [`${packageRoot}/package.json`]: JSON.stringify({
          name: "@openai/codex",
          version: "1.0.0",
        }),
      },
      probes: {
        [`${npm} root -g`]: {
          stdout: "/opt/node-b/lib/node_modules",
          stderr: "",
          exitCode: 0,
        },
        [`${npm} view @openai/codex@latest version --json`]: {
          stdout: '"1.1.0"',
          stderr: "",
          exitCode: 0,
        },
      },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Managed by npm",
        ownershipVerified: true,
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        update: {
          executable: npm,
          args: [
            "install",
            "-g",
            "--prefix",
            packagePrefix,
            "--allow-scripts=@openai/codex",
            "@openai/codex@latest",
          ],
        },
      });
    }),
  );
});

it.effect("rejects an npm package nested under another global package", () => {
  const prefix = "/opt/node";
  const packageRoot = `${prefix}/lib/node_modules/host/node_modules/@openai/codex`;
  const npm = `${prefix}/bin/npm`;
  return resolveInstallation(
    context({
      binaryPath: "codex",
      resolvedCommandPath: `${prefix}/bin/codex`,
      realCommandPath: `${packageRoot}/bin/codex.js`,
      commands: { npm },
      files: {
        [`${packageRoot}/package.json`]: JSON.stringify({
          name: "@openai/codex",
          version: "1.0.0",
        }),
      },
      probes: {
        [`${npm} root -g`]: {
          stdout: `${prefix}/lib/node_modules`,
          stderr: "",
          exitCode: 0,
        },
      },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Unknown installation — verification failed",
        ownershipVerified: false,
        update: null,
      });
    }),
  );
});

it.effect("rejects a nested npm package in a Windows global prefix", () => {
  const prefix = "C:/Users/test/AppData/Roaming/npm";
  const packageRoot = `${prefix}/node_modules/host/node_modules/@openai/codex`;
  const npm = `${prefix}/npm.cmd`;
  return resolveInstallation(
    context({
      binaryPath: "codex",
      resolvedCommandPath: `${prefix}/codex.cmd`,
      realCommandPath: `${packageRoot}/bin/codex.js`,
      platform: "win32",
      commands: { npm },
      files: {
        [`${packageRoot}/package.json`]: JSON.stringify({
          name: "@openai/codex",
          version: "1.0.0",
        }),
      },
      probes: {
        [`${npm} root -g`]: {
          stdout: `${prefix}/node_modules`,
          stderr: "",
          exitCode: 0,
        },
      },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Unknown installation — verification failed",
        ownershipVerified: false,
        update: null,
      });
    }),
  );
});

it.effect("does not fall back to npm when a managed package path has no available owner", () =>
  resolveInstallation(
    context({
      binaryPath: "codex",
      resolvedCommandPath: "/opt/node/lib/node_modules/@openai/codex/bin/codex.js",
      commands: { npm: "/usr/local/bin/npm" },
      probes: {
        "/usr/local/bin/npm root -g": {
          stdout: "/usr/local/lib/node_modules",
          stderr: "",
          exitCode: 0,
        },
      },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Unknown installation — verification failed",
        ownershipVerified: false,
        update: null,
      });
    }),
  ),
);

it.effect("proves npm ownership through a Windows global command wrapper", () => {
  const prefix = "C:/Users/test/AppData/Roaming/npm";
  const npm = `${prefix}/npm.cmd`;
  return resolveInstallation(
    context({
      binaryPath: "codex",
      resolvedCommandPath: `${prefix}/codex.cmd`,
      platform: "win32",
      commands: { npm },
      files: {
        [`${prefix}/codex.cmd`]:
          '@IF EXIST "%~dp0\\node.exe" ("%~dp0\\node.exe" "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js")',
        [`${prefix}/node_modules/@openai/codex/package.json`]: JSON.stringify({
          name: "@openai/codex",
          version: "1.0.0",
        }),
      },
      probes: {
        [`${npm} root -g`]: {
          stdout: `${prefix}/node_modules`,
          stderr: "",
          exitCode: 0,
        },
        [`${npm} view @openai/codex@latest version --json`]: {
          stdout: '"1.1.0"',
          stderr: "",
          exitCode: 0,
        },
      },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Managed by npm",
        ownershipVerified: true,
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        update: {
          executable: npm,
          args: [
            "install",
            "-g",
            "--prefix",
            prefix,
            "--allow-scripts=@openai/codex",
            "@openai/codex@latest",
          ],
        },
      });
    }),
  );
});

it.effect("reads a POSIX package wrapper once across Node manager probes", () => {
  const prefix = "/home/test/.local";
  const wrapper = `${prefix}/bin/codex`;
  const packageRoot = `${prefix}/share/pnpm/global/v5/node_modules/@openai/codex`;
  const pnpm = `${prefix}/bin/pnpm`;
  const textFileReads: Array<{ readonly path: string; readonly maxBytes?: number }> = [];
  return resolveInstallation(
    context({
      binaryPath: "codex",
      resolvedCommandPath: wrapper,
      commands: { pnpm },
      textFileReads,
      files: {
        [wrapper]:
          '#!/bin/sh\nexec "$basedir/../share/pnpm/global/v5/node_modules/@openai/codex/bin/codex.js" "$@"',
        [`${packageRoot}/package.json`]: JSON.stringify({
          name: "@openai/codex",
          version: "1.0.0",
        }),
      },
      probes: {
        [`${pnpm} root -g`]: {
          stdout: `${prefix}/share/pnpm/global/v5/node_modules`,
          stderr: "",
          exitCode: 0,
        },
        [`${pnpm} view @openai/codex@latest version --json`]: {
          stdout: '"1.1.0"',
          stderr: "",
          exitCode: 0,
        },
      },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Managed by pnpm",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
      });
      expect(textFileReads.filter((read) => read.path === wrapper)).toEqual([
        { path: wrapper, maxBytes: 64 * 1_024 },
      ]);
    }),
  );
});

it.effect("skips oversized command wrappers without weakening ownership", () => {
  const wrapper = "/home/test/.local/bin/codex";
  const textFileReads: Array<{ readonly path: string; readonly maxBytes?: number }> = [];
  return resolveInstallation(
    context({
      binaryPath: "codex",
      resolvedCommandPath: wrapper,
      textFileReads,
      files: {
        [wrapper]: `${"x".repeat(64 * 1_024)}\n/node_modules/@openai/codex/bin/codex.js`,
      },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Unknown installation",
        ownershipVerified: false,
        update: null,
      });
      expect(textFileReads).toEqual([{ path: wrapper, maxBytes: 64 * 1_024 }]);
    }),
  );
});

it.effect("does not match a wrapper for a package with a shared name prefix", () => {
  const prefix = "C:/Users/test/AppData/Roaming/npm";
  const npm = `${prefix}/npm.cmd`;
  const wrapper = `${prefix}/codex.cmd`;
  const packageRoot = `${prefix}/node_modules/@openai/codex`;
  return resolveInstallation(
    context({
      binaryPath: "codex",
      resolvedCommandPath: wrapper,
      platform: "win32",
      commands: { npm },
      files: {
        [wrapper]: `node  "%~dp0\\node_modules\\@openai\\codex-malicious\\bin\\codex.js" %*`,
        [`${packageRoot}/package.json`]: JSON.stringify({
          name: "@openai/codex",
          version: "1.0.0",
        }),
      },
      probes: {
        [`${npm} root -g`]: { stdout: `${prefix}/node_modules`, stderr: "", exitCode: 0 },
      },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation.update).toBeNull();
      expect(installation.ownershipVerified).toBe(false);
    }),
  );
});

it.effect("resolves a pnpm Windows wrapper into its versioned global package root", () => {
  const home = "C:/Users/test/AppData/Local/pnpm";
  const packageRoot = `${home}/global/v11/hash/node_modules/@openai/codex`;
  const pnpm = "C:/Users/test/scoop/shims/pnpm.exe";
  return resolveInstallation(
    context({
      binaryPath: "codex",
      resolvedCommandPath: `${home}/bin/codex.CMD`,
      platform: "win32",
      commands: { pnpm },
      files: {
        [`${home}/bin/codex.CMD`]:
          '@"%~dp0\\..\\global\\v11\\hash\\node_modules\\@openai\\codex\\bin\\codex.exe" %*',
        [`${packageRoot}/package.json`]: JSON.stringify({
          name: "@openai/codex",
          version: "1.0.0",
        }),
      },
      probes: {
        [`${pnpm} root -g`]: {
          stdout: `${home}/global/v11`,
          stderr: "",
          exitCode: 0,
        },
        [`${pnpm} view @openai/codex@latest version --json`]: {
          stdout: '"1.1.0"',
          stderr: "",
          exitCode: 0,
        },
      },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Managed by pnpm",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        update: { executable: pnpm },
      });
    }),
  );
});

it.effect("proves npm ownership across a Scoop Node persistent-bin junction", () => {
  const currentBin = "C:/Users/test/scoop/apps/nodejs-lts/current/bin";
  const persistentBin = "C:/Users/test/scoop/persist/nodejs-lts/bin";
  const packageRoot = `${persistentBin}/node_modules/@openai/codex`;
  const npm = "C:/Users/test/scoop/apps/nodejs-lts/current/npm.cmd";
  return resolveInstallation(
    context({
      binaryPath: "codex",
      resolvedCommandPath: `${currentBin}/codex.cmd`,
      platform: "win32",
      commands: { npm },
      realPaths: {
        [`${currentBin}/node_modules/@openai/codex`.toLowerCase()]: packageRoot,
      },
      files: {
        [`${currentBin}/codex.cmd`]:
          '@ECHO off\nSET dp0=%~dp0\n"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.exe" %*',
        [`${packageRoot}/package.json`]: JSON.stringify({
          name: "@openai/codex",
          version: "1.0.0",
        }),
      },
      probes: {
        [`${npm} root -g`]: {
          stdout: `${persistentBin}/node_modules`,
          stderr: "",
          exitCode: 0,
        },
        [`${npm} view @openai/codex@latest version --json`]: {
          stdout: '"1.1.0"',
          stderr: "",
          exitCode: 0,
        },
      },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Managed by npm",
        ownershipVerified: true,
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        update: { executable: npm },
      });
    }),
  );
});

it.effect("proves Bun ownership for its copied Windows global executable", () => {
  const home = "C:/Users/test/.bun";
  const bun = `${home}/bin/bun.exe`;
  return resolveInstallation(
    context({
      binaryPath: "codex",
      resolvedCommandPath: `${home}/bin/codex.exe`,
      platform: "win32",
      commands: { bun },
      files: {
        [`${home}/install/global/node_modules/@openai/codex/package.json`]: JSON.stringify({
          name: "@openai/codex",
          version: "1.0.0",
        }),
      },
      probes: {
        [`${bun} pm bin -g`]: { stdout: `${home}/bin`, stderr: "", exitCode: 0 },
        [`${bun} pm view @openai/codex version`]: {
          stdout: "1.1.0",
          stderr: "",
          exitCode: 0,
        },
      },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Managed by Bun",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        update: { executable: bun },
      });
    }),
  );
});

it.effect("proves Homebrew ownership and fails closed for unresolved shims", () => {
  const brew = "/opt/homebrew/bin/brew";
  const resolve = (version: string) => {
    const formulaPrefix = "/opt/homebrew/opt/codex";
    const realFormulaPrefix = `/opt/homebrew/Cellar/codex/${version}`;
    return resolveInstallation(
      context({
        binaryPath: "codex",
        resolvedCommandPath: "/opt/homebrew/bin/codex",
        realCommandPath: `${realFormulaPrefix}/bin/codex`,
        commands: { brew },
        realPaths: { [formulaPrefix]: realFormulaPrefix },
        probes: {
          [`${brew} --prefix --installed codex`]: {
            stdout: formulaPrefix,
            stderr: "",
            exitCode: 0,
          },
          [`${brew} --caskroom codex`]: { stdout: "", stderr: "", exitCode: 1 },
          [`${brew} info --json=v2 codex`]: {
            stdout: JSON.stringify({
              formulae: [
                {
                  installed: [{ version }],
                  versions: { stable: "1.1.0" },
                },
              ],
            }),
            stderr: "",
            exitCode: 0,
          },
        },
      }),
      catalog,
    );
  };
  return Effect.gen(function* () {
    const before = yield* resolve("1.0.0");
    const after = yield* resolve("1.1.0");
    expect(before).toMatchObject({
      label: "Managed by Homebrew",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      update: { executable: brew, args: ["upgrade", "codex"] },
    });
    expect(after.identityKey).toBe(before.identityKey);
    expect(after.lockKey).toBe(before.lockKey);

    const unresolved = yield* resolveInstallation(
      context({
        binaryPath: "codex",
        resolvedCommandPath: "/opt/homebrew/bin/codex",
        commands: { npm: "/usr/local/bin/npm" },
        probes: {
          "/usr/local/bin/npm root -g": {
            stdout: "/usr/local/lib/node_modules",
            stderr: "",
            exitCode: 0,
          },
        },
      }),
      catalog,
    );
    expect(unresolved).toMatchObject({
      label: "Unknown installation — verification failed",
      ownershipVerified: false,
      update: null,
    });
  });
});

it.effect("accepts Homebrew cask metadata with a scalar installed version", () => {
  const brew = "/opt/homebrew/bin/brew";
  const caskPrefix = "/opt/homebrew/Caskroom/codex";
  return resolveInstallation(
    context({
      binaryPath: "codex",
      resolvedCommandPath: "/opt/homebrew/bin/codex",
      realCommandPath: `${caskPrefix}/0.149.1/codex-aarch64-apple-darwin`,
      commands: { brew },
      probes: {
        [`${brew} --prefix --installed codex`]: { stdout: "", stderr: "", exitCode: 1 },
        [`${brew} --caskroom codex`]: { stdout: caskPrefix, stderr: "", exitCode: 0 },
        [`${brew} info --json=v2 codex`]: {
          stdout: JSON.stringify({
            casks: [{ installed: "0.149.1", version: "0.150.0" }],
          }),
          stderr: "",
          exitCode: 0,
        },
      },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Managed by Homebrew",
        currentVersion: "0.149.1",
        latestVersion: "0.150.0",
        update: { executable: brew, args: ["upgrade", "--cask", "codex"] },
      });
    }),
  );
});

it.effect("uses cask metadata and updates when formula and cask names collide", () => {
  const brew = "/opt/homebrew/bin/brew";
  const formulaPrefix = "/opt/homebrew/opt/codex";
  const realFormulaPrefix = "/opt/homebrew/Cellar/codex/9.0.0";
  const caskPrefix = "/opt/homebrew/Caskroom/codex";
  return resolveInstallation(
    context({
      binaryPath: "codex",
      resolvedCommandPath: "/opt/homebrew/bin/codex",
      realCommandPath: `${caskPrefix}/0.149.1/codex-aarch64-apple-darwin`,
      commands: { brew },
      realPaths: { [formulaPrefix]: realFormulaPrefix },
      probes: {
        [`${brew} --prefix --installed codex`]: {
          stdout: formulaPrefix,
          stderr: "",
          exitCode: 0,
        },
        [`${brew} --caskroom codex`]: { stdout: caskPrefix, stderr: "", exitCode: 0 },
        [`${brew} info --json=v2 codex`]: {
          stdout: JSON.stringify({
            formulae: [
              {
                installed: [{ version: "9.0.0" }],
                versions: { stable: "9.1.0" },
              },
            ],
            casks: [{ installed: ["0.149.1"], version: "0.150.0" }],
          }),
          stderr: "",
          exitCode: 0,
        },
      },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Managed by Homebrew",
        currentVersion: "0.149.1",
        latestVersion: "0.150.0",
        update: {
          executable: brew,
          args: ["upgrade", "--cask", "codex"],
          displayCommand: "brew upgrade --cask codex",
        },
      });
    }),
  );
});

it.effect("derives a Homebrew alias from the verified Caskroom path", () => {
  const brew = "/opt/homebrew/bin/brew";
  const formula = "codex@latest";
  const caskPrefix = `/opt/homebrew/Caskroom/${formula}`;
  return resolveInstallation(
    context({
      binaryPath: "codex",
      resolvedCommandPath: "/opt/homebrew/bin/codex",
      realCommandPath: `${caskPrefix}/0.150.0/codex-aarch64-apple-darwin`,
      commands: { brew },
      probes: {
        [`${brew} --prefix --installed ${formula}`]: { stdout: "", stderr: "", exitCode: 1 },
        [`${brew} --caskroom ${formula}`]: { stdout: caskPrefix, stderr: "", exitCode: 0 },
        [`${brew} info --json=v2 ${formula}`]: {
          stdout: JSON.stringify({
            casks: [{ installed: "0.150.0", version: "0.151.0" }],
          }),
          stderr: "",
          exitCode: 0,
        },
      },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Managed by Homebrew",
        currentVersion: "0.150.0",
        latestVersion: "0.151.0",
        update: { executable: brew, args: ["upgrade", "--cask", formula] },
      });
    }),
  );
});

it.effect("keeps an unclassified explicit path manual-only", () =>
  resolveInstallation(
    context({
      binaryPath: "/custom/bin/codex",
      resolvedCommandPath: "/custom/bin/codex",
      commands: { npm: "/usr/local/bin/npm" },
    }),
    catalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Unknown installation",
        ownershipVerified: false,
        update: null,
      });
    }),
  ),
);

it.effect("proves WinGet ownership and updates through the mapped source name", () => {
  const reg = "C:\\Windows\\System32\\reg.exe";
  const uninstall = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
  const key = `HKEY_CURRENT_USER\\${uninstall}\\OpenAI.Codex_Microsoft.Winget.Source_8wekyb3d8bbwe`;
  const link = "C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Links\\codex.exe";
  const target =
    "C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenAI.Codex_Microsoft.Winget.Source_8wekyb3d8bbwe\\codex.exe";
  const winget = "C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe";
  const probes: Record<string, MaintenanceProbeResult> = {
    [`${reg} query HKCU\\${uninstall} /s /f OpenAI.Codex /d /e /reg:64`]: {
      stdout: key,
      stderr: "",
      exitCode: 0,
    },
    [`${reg} query HKLM\\${uninstall} /s /f OpenAI.Codex /d /e /reg:64`]: {
      stdout: "",
      stderr: "",
      exitCode: 1,
    },
    [`${reg} query HKLM\\${uninstall} /s /f OpenAI.Codex /d /e /reg:32`]: {
      stdout: "",
      stderr: "",
      exitCode: 1,
    },
    [`${reg} query ${key} /reg:64`]: {
      stdout: `${key}\n    DisplayVersion    REG_SZ    1.0.0\n    WinGetPackageIdentifier    REG_SZ    OpenAI.Codex\n    WinGetSourceIdentifier    REG_SZ    Microsoft.Winget.Source_8wekyb3d8bbwe\n    SymlinkFullPath    REG_SZ    ${link}\n    TargetFullPath    REG_SZ    ${target}`,
      stderr: "",
      exitCode: 0,
    },
    [`${winget} source export --disable-interactivity`]: {
      stdout:
        '{"Data":"Microsoft.Winget.Source_8wekyb3d8bbwe","Identifier":"Microsoft.Winget.Source_8wekyb3d8bbwe","Name":"winget"}',
      stderr: "",
      exitCode: 0,
    },
    [`${winget} show --id OpenAI.Codex --exact --source winget --versions --accept-source-agreements --disable-interactivity`]:
      {
        stdout: "Version\n-------\n1.1.0\n1.0.0",
        stderr: "",
        exitCode: 0,
      },
  };
  const showKey = `${winget} show --id OpenAI.Codex --exact --source winget --versions --accept-source-agreements --disable-interactivity`;
  const resolve = (resolvedProbes: Readonly<Record<string, MaintenanceProbeResult>>) =>
    resolveInstallation(
      context({
        binaryPath: "codex",
        resolvedCommandPath: link,
        realCommandPath: target,
        platform: "win32",
        commands: { winget },
        probes: resolvedProbes,
      }),
      catalog,
    );
  return Effect.gen(function* () {
    const installation = yield* resolve(probes);
    expect(installation).toMatchObject({
      label: "Managed by WinGet",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      update: {
        executable: winget,
        args: [
          "upgrade",
          "--id",
          "OpenAI.Codex",
          "--exact",
          "--source",
          "winget",
          "--scope",
          "user",
          "--accept-source-agreements",
          "--disable-interactivity",
        ],
      },
    });
    const ascendingVersions = yield* resolve({
      ...probes,
      [showKey]: { stdout: "Version\n-------\n1.0.0\n1.1.0", stderr: "", exitCode: 0 },
    });
    expect(ascendingVersions.latestVersion).toBe("1.1.0");
    const failedShow = yield* resolve({
      ...probes,
      [showKey]: { stdout: "Error 1.9.0", stderr: "source unavailable", exitCode: 1 },
    });
    expect(failedShow.latestVersion).toBeNull();
  });
});

it("parses WinGet portable ownership metadata including the original source", () => {
  expect(
    parseWingetPortableArp(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenAI.Codex
    DisplayVersion    REG_SZ    1.2.3
    WinGetPackageIdentifier    REG_SZ    OpenAI.Codex
    WinGetSourceIdentifier    REG_SZ    private-source
    SymlinkFullPath    REG_SZ    C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Links\\codex.exe
    TargetFullPath    REG_SZ    C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenAI.Codex\\codex.exe
`),
  ).toEqual([
    {
      displayVersion: "1.2.3",
      packageId: "OpenAI.Codex",
      sourceId: "private-source",
      symlinkPath: "C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Links\\codex.exe",
      targetPath:
        "C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenAI.Codex\\codex.exe",
    },
  ]);
});

it("maps a WinGet source identifier back to the CLI source name", () => {
  expect(
    parseWingetSources(
      '{"Identifier":"StoreEdgeFD","Name":"msstore"}\n' +
        '{"Identifier":"Microsoft.Winget.Source_8wekyb3d8bbwe","Name":"winget"}\n',
    ),
  ).toEqual([
    { data: null, identifier: "StoreEdgeFD", name: "msstore" },
    {
      data: null,
      identifier: "Microsoft.Winget.Source_8wekyb3d8bbwe",
      name: "winget",
    },
  ]);
});
