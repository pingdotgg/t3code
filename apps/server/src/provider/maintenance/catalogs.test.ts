import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  canonicalPath,
  INSTALLER_METADATA_MAX_BYTES,
  type InstallationContext,
  type MaintenanceProbeResult,
  type ResolvedInstallation,
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

interface TestContextInput {
  readonly binaryPath: string;
  readonly resolvedCommandPath: string;
  readonly realCommandPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly files?: Readonly<Record<string, string>>;
  readonly commands?: Readonly<Record<string, string>>;
  readonly probes?: Readonly<Record<string, MaintenanceProbeResult>>;
  readonly realPaths?: Readonly<Record<string, string>>;
  readonly textFileReads?: Array<{ readonly path: string }>;
}

function context(input: TestContextInput): InstallationContext {
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
    resolvedCommandPath: input.resolvedCommandPath,
    realCommandPath: input.realCommandPath ?? input.resolvedCommandPath,
    environment: input.environment ?? { PATH: "test-path" },
    platform: input.platform ?? "linux",
    readTextFile: (path) => {
      input.textFileReads?.push({ path });
      const value = files.get(path.replaceAll("\\", "/").toLowerCase()) ?? null;
      return Effect.succeed(
        value !== null && Buffer.byteLength(value) > INSTALLER_METADATA_MAX_BYTES ? null : value,
      );
    },
    realPath: (path) =>
      Effect.succeed(input.realPaths?.[path.replaceAll("\\", "/").toLowerCase()] ?? path),
    resolveCommand: (command) => Effect.succeed(input.commands?.[command] ?? null),
    run: (executable, args) =>
      Effect.succeed(input.probes?.[`${executable} ${args.join(" ")}`] ?? null),
  };
}

const resolveCatalog = (input: TestContextInput) => resolveInstallation(context(input), catalog);

const probe = (stdout: string, exitCode = 0, stderr = ""): MaintenanceProbeResult => ({
  stdout,
  stderr,
  exitCode,
});

const packageManifest = (version: string) => JSON.stringify({ name: "@openai/codex", version });

function expectManualInstallation(installation: ResolvedInstallation, verificationFailed = false) {
  expect(installation).toMatchObject({
    label: verificationFailed
      ? "Unknown installation — verification failed"
      : "Unknown installation",
    ownershipVerified: false,
    update: null,
  });
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
  return resolveCatalog({
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
  }).pipe(
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
  return resolveCatalog({
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
      [`${scoop} config global_path`]: probe(globalRoot),
    },
  }).pipe(
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
  return resolveCatalog({
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
      [`${scoop} config global_path`]: probe(observedGlobalRoot),
    },
  }).pipe(
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
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: "/custom/bin/codex",
    commands: { npm: "/usr/local/bin/npm" },
    probes: {
      "/usr/local/bin/npm root -g": probe("/usr/local/lib/node_modules"),
      "/usr/local/bin/npm view @openai/codex@latest version --json": probe('"9.9.9"'),
    },
  }).pipe(
    Effect.map((installation) => {
      expectManualInstallation(installation);
      expect(installation.ownershipVerified).toBe(false);
      expect(installation.update).toBeNull();
    }),
  );
});

it.effect("pins npm updates to the verified package prefix", () => {
  const packagePrefix = "/opt/node-a";
  const packageRoot = `${packagePrefix}/lib/node_modules/@openai/codex`;
  const npm = "/opt/node-b/bin/npm";
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: `${packagePrefix}/bin/codex`,
    realCommandPath: `${packageRoot}/bin/codex.js`,
    commands: { npm },
    files: {
      [`${packageRoot}/package.json`]: packageManifest("1.0.0"),
    },
    probes: {
      [`${npm} root -g`]: probe("/opt/node-b/lib/node_modules"),
      [`${npm} view @openai/codex@latest version --json`]: probe('"1.1.0"'),
    },
  }).pipe(
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
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: `${prefix}/bin/codex`,
    realCommandPath: `${packageRoot}/bin/codex.js`,
    commands: { npm },
    files: {
      [`${packageRoot}/package.json`]: packageManifest("1.0.0"),
    },
    probes: {
      [`${npm} root -g`]: probe(`${prefix}/lib/node_modules`),
    },
  }).pipe(
    Effect.map((installation) => {
      expectManualInstallation(installation, true);
    }),
  );
});

it.effect("rejects a nested npm package in a Windows global prefix", () => {
  const prefix = "C:/Users/test/AppData/Roaming/npm";
  const packageRoot = `${prefix}/node_modules/host/node_modules/@openai/codex`;
  const npm = `${prefix}/npm.cmd`;
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: `${prefix}/codex.cmd`,
    realCommandPath: `${packageRoot}/bin/codex.js`,
    platform: "win32",
    commands: { npm },
    files: {
      [`${packageRoot}/package.json`]: packageManifest("1.0.0"),
    },
    probes: {
      [`${npm} root -g`]: probe(`${prefix}/node_modules`),
    },
  }).pipe(
    Effect.map((installation) => {
      expectManualInstallation(installation, true);
    }),
  );
});

it.effect("rejects a nested package inside a pnpm global root", () => {
  const prefix = "/opt/pnpm";
  const wrapper = `${prefix}/bin/codex`;
  const managerRoot = `${prefix}/global/5/node_modules`;
  const packageRoot = `${managerRoot}/host/node_modules/@openai/codex`;
  const pnpm = `${prefix}/bin/pnpm`;
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: wrapper,
    commands: { pnpm },
    files: {
      [wrapper]: `exec "$basedir/../global/5/node_modules/host/node_modules/@openai/codex/bin/codex.js" "$@"`,
      [`${packageRoot}/package.json`]: packageManifest("1.0.0"),
    },
    probes: {
      [`${pnpm} root -g`]: probe(managerRoot),
    },
  }).pipe(
    Effect.map((installation) => {
      expectManualInstallation(installation, true);
    }),
  );
});

it.effect("does not fall back to npm when a managed package path has no available owner", () =>
  resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: "/opt/node/lib/node_modules/@openai/codex/bin/codex.js",
    commands: { npm: "/usr/local/bin/npm" },
    probes: {
      "/usr/local/bin/npm root -g": probe("/usr/local/lib/node_modules"),
    },
  }).pipe(
    Effect.map((installation) => {
      expectManualInstallation(installation, true);
    }),
  ),
);

it.effect("proves npm ownership through a Windows global command wrapper", () => {
  const prefix = "C:/Users/test/AppData/Roaming/npm";
  const npm = `${prefix}/npm.cmd`;
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: `${prefix}/codex.cmd`,
    platform: "win32",
    commands: { npm },
    files: {
      [`${prefix}/codex.cmd`]:
        '@IF EXIST "%~dp0\\node.exe" ("%~dp0\\node.exe" "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*)',
      [`${prefix}/node_modules/@openai/codex/package.json`]: packageManifest("1.0.0"),
    },
    probes: {
      [`${npm} root -g`]: probe(`${prefix}/node_modules`),
      [`${npm} view @openai/codex@latest version --json`]: probe('"1.1.0"'),
    },
  }).pipe(
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
  const textFileReads: Array<{ readonly path: string }> = [];
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: wrapper,
    commands: { pnpm },
    textFileReads,
    files: {
      [wrapper]:
        '#!/bin/sh\nexec "$basedir/../share/pnpm/global/v5/node_modules/@openai/codex/bin/codex.js" "$@"',
      [`${packageRoot}/package.json`]: packageManifest("1.0.0"),
    },
    probes: {
      [`${pnpm} root -g`]: probe(`${prefix}/share/pnpm/global/v5/node_modules`),
      [`${pnpm} view @openai/codex@latest version --json`]: probe('"1.1.0"'),
    },
  }).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Managed by pnpm",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
      });
      expect(textFileReads.filter((read) => read.path === wrapper)).toEqual([{ path: wrapper }]);
    }),
  );
});

it.effect("skips oversized command wrappers without weakening ownership", () => {
  const wrapper = "/home/test/.local/bin/codex";
  const textFileReads: Array<{ readonly path: string }> = [];
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: wrapper,
    textFileReads,
    files: {
      [wrapper]: `${"x".repeat(64 * 1_024)}\n/node_modules/@openai/codex/bin/codex.js`,
    },
  }).pipe(
    Effect.map((installation) => {
      expectManualInstallation(installation);
      expect(textFileReads).toEqual([{ path: wrapper }]);
    }),
  );
});

it.effect("does not match a wrapper for a package with a shared name prefix", () => {
  const prefix = "C:/Users/test/AppData/Roaming/npm";
  const npm = `${prefix}/npm.cmd`;
  const wrapper = `${prefix}/codex.cmd`;
  const packageRoot = `${prefix}/node_modules/@openai/codex`;
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: wrapper,
    platform: "win32",
    commands: { npm },
    files: {
      [wrapper]: `node  "%~dp0\\node_modules\\@openai\\codex-malicious\\bin\\codex.js" %*`,
      [`${packageRoot}/package.json`]: packageManifest("1.0.0"),
    },
    probes: {
      [`${npm} root -g`]: probe(`${prefix}/node_modules`),
    },
  }).pipe(
    Effect.map((installation) => {
      expect(installation.update).toBeNull();
      expect(installation.ownershipVerified).toBe(false);
    }),
  );
});

it.effect("rejects package text that is not the wrapper execution target", () => {
  const prefix = "/opt/node";
  const wrapper = `${prefix}/bin/codex`;
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: wrapper,
    commands: { npm: `${prefix}/bin/npm` },
    files: {
      [wrapper]:
        'echo "/opt/node/lib/node_modules/@openai/codex/bin/codex.js" "$@"\nexec "/tmp/unrelated-codex"',
      [`${prefix}/lib/node_modules/@openai/codex/package.json`]: packageManifest("1.0.0"),
    },
    probes: {
      [`${prefix}/bin/npm root -g`]: probe(`${prefix}/lib/node_modules`),
    },
  }).pipe(
    Effect.map((installation) => {
      expectManualInstallation(installation, true);
    }),
  );
});

it.effect("rejects wrappers with an unowned alternate execution target", () => {
  const prefix = "/opt/node";
  const wrapper = `${prefix}/bin/codex`;
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: wrapper,
    commands: { npm: `${prefix}/bin/npm` },
    files: {
      [wrapper]: [
        `exec "$basedir/../lib/node_modules/@openai/codex/bin/codex.js" "$@"`,
        `exec "/tmp/unrelated-codex" "$@"`,
      ].join("\n"),
      [`${prefix}/lib/node_modules/@openai/codex/package.json`]: packageManifest("1.0.0"),
    },
    probes: {
      [`${prefix}/bin/npm root -g`]: probe(`${prefix}/lib/node_modules`),
    },
  }).pipe(
    Effect.map((installation) => {
      expectManualInstallation(installation, true);
    }),
  );
});

it.effect("fails closed for malformed package metadata", () => {
  const prefix = "/opt/node";
  const wrapper = `${prefix}/bin/codex`;
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: wrapper,
    commands: { npm: `${prefix}/bin/npm` },
    files: {
      [wrapper]: `exec "$basedir/../lib/node_modules/@openai/codex/bin/codex.js" "$@"`,
      [`${prefix}/lib/node_modules/@openai/codex/package.json`]: "{not-json",
    },
    probes: {
      [`${prefix}/bin/npm root -g`]: probe(`${prefix}/lib/node_modules`),
    },
  }).pipe(
    Effect.map((installation) => {
      expectManualInstallation(installation, true);
    }),
  );
});

it.effect("fails closed for oversized package metadata", () => {
  const prefix = "/opt/node";
  const wrapper = `${prefix}/bin/codex`;
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: wrapper,
    commands: { npm: `${prefix}/bin/npm` },
    files: {
      [wrapper]: `exec "$basedir/../lib/node_modules/@openai/codex/bin/codex.js" "$@"`,
      [`${prefix}/lib/node_modules/@openai/codex/package.json`]: `${packageManifest("1.0.0")}${" ".repeat(INSTALLER_METADATA_MAX_BYTES)}`,
    },
    probes: {
      [`${prefix}/bin/npm root -g`]: probe(`${prefix}/lib/node_modules`),
    },
  }).pipe(
    Effect.map((installation) => {
      expectManualInstallation(installation, true);
    }),
  );
});

it.effect("resolves a pnpm Windows wrapper into its versioned global package root", () => {
  const home = "C:/Users/test/AppData/Local/pnpm";
  const packageRoot = `${home}/global/v11/hash/node_modules/@openai/codex`;
  const pnpm = "C:/Users/test/scoop/shims/pnpm.exe";
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: `${home}/bin/codex.CMD`,
    platform: "win32",
    commands: { pnpm },
    files: {
      [`${home}/bin/codex.CMD`]:
        '@"%~dp0\\..\\global\\v11\\hash\\node_modules\\@openai\\codex\\bin\\codex.exe" %*',
      [`${packageRoot}/package.json`]: packageManifest("1.0.0"),
    },
    probes: {
      [`${pnpm} root -g`]: probe(`${home}/global/v11`),
      [`${pnpm} view @openai/codex@latest version --json`]: probe('"1.1.0"'),
    },
  }).pipe(
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
  const currentTarget = `${currentBin}/node_modules/@openai/codex/bin/codex.exe`;
  const persistentTarget = `${persistentBin}/node_modules/@openai/codex/bin/codex.exe`;
  const npm = "C:/Users/test/scoop/apps/nodejs-lts/current/npm.cmd";
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: `${currentBin}/codex.cmd`,
    platform: "win32",
    commands: { npm },
    realPaths: {
      [`${currentBin}/node_modules/@openai/codex`.toLowerCase()]: packageRoot,
      [currentTarget.toLowerCase()]: persistentTarget,
    },
    files: {
      [`${currentBin}/codex.cmd`]:
        '@ECHO off\nSET dp0=%~dp0\n"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.exe" %*',
      [`${packageRoot}/package.json`]: packageManifest("1.0.0"),
    },
    probes: {
      [`${npm} root -g`]: probe(`${persistentBin}/node_modules`),
      [`${npm} view @openai/codex@latest version --json`]: probe('"1.1.0"'),
    },
  }).pipe(
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
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: `${home}/bin/codex.exe`,
    platform: "win32",
    commands: { bun },
    files: {
      [`${home}/install/global/node_modules/@openai/codex/package.json`]: packageManifest("1.0.0"),
    },
    probes: {
      [`${bun} pm bin -g`]: probe(`${home}/bin`),
      [`${bun} pm view @openai/codex version`]: probe("1.1.0"),
    },
  }).pipe(
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
    return resolveCatalog({
      binaryPath: "codex",
      resolvedCommandPath: "/opt/homebrew/bin/codex",
      realCommandPath: `${realFormulaPrefix}/bin/codex`,
      commands: { brew },
      realPaths: { [formulaPrefix]: realFormulaPrefix },
      probes: {
        [`${brew} --prefix --installed codex`]: probe(formulaPrefix),
        [`${brew} --caskroom codex`]: probe("", 1),
        [`${brew} info --json=v2 codex`]: probe(
          JSON.stringify({
            formulae: [
              {
                installed: [{ version }],
                versions: { stable: "1.1.0" },
              },
            ],
          }),
        ),
      },
    });
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

    const unresolved = yield* resolveCatalog({
      binaryPath: "codex",
      resolvedCommandPath: "/opt/homebrew/bin/codex",
      commands: { npm: "/usr/local/bin/npm" },
      probes: {
        "/usr/local/bin/npm root -g": probe("/usr/local/lib/node_modules"),
      },
    });
    expectManualInstallation(unresolved, true);
  });
});

it.effect("does not classify a Linux /usr/local/bin executable as Homebrew", () =>
  resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: "/usr/local/bin/codex",
    realCommandPath: "/usr/local/bin/codex",
    commands: {
      brew: "/home/linuxbrew/.linuxbrew/bin/brew",
      npm: "/usr/local/bin/npm",
    },
    probes: {
      "/usr/local/bin/npm root -g": probe("/usr/local/lib/node_modules"),
    },
  }).pipe(
    Effect.map((installation) => {
      expectManualInstallation(installation, true);
    }),
  ),
);

it.effect("rejects Homebrew ownership from an unrelated formula", () => {
  const brew = "/opt/homebrew/bin/brew";
  const formulaPrefix = "/opt/homebrew/opt/other-tool";
  const realFormulaPrefix = "/opt/homebrew/Cellar/other-tool/1.2.3";
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: "/opt/homebrew/bin/codex",
    realCommandPath: `${realFormulaPrefix}/bin/codex`,
    commands: { brew },
    realPaths: { [formulaPrefix]: realFormulaPrefix },
    probes: {
      [`${brew} --prefix --installed other-tool`]: probe(formulaPrefix),
      [`${brew} info --json=v2 other-tool`]: probe(
        JSON.stringify({
          formulae: [
            {
              installed: [{ version: "1.2.3" }],
              versions: { stable: "1.2.4" },
            },
          ],
        }),
      ),
    },
  }).pipe(
    Effect.map((installation) => {
      expectManualInstallation(installation, true);
    }),
  );
});

it.effect("preserves a matching tap-qualified Homebrew formula", () => {
  const brew = "/opt/homebrew/bin/brew";
  const formula = "example/tap/scoped-package-tool";
  const formulaPrefix = "/opt/homebrew/opt/scoped-package-tool";
  const realFormulaPrefix = "/opt/homebrew/Cellar/scoped-package-tool/1.2.3";
  const tapCatalog = makeProviderInstallationCatalog({
    provider,
    packageName: "@example/scoped-package-tool",
    executableName: "scoped-package-tool",
    homebrewFormula: formula,
    native: null,
    instructionsUrl: "https://example.com/scoped-package-tool",
  });
  return resolveInstallation(
    context({
      binaryPath: "scoped-package-tool",
      resolvedCommandPath: "/opt/homebrew/bin/scoped-package-tool",
      realCommandPath: `${realFormulaPrefix}/bin/scoped-package-tool`,
      commands: { brew },
      realPaths: { [formulaPrefix]: realFormulaPrefix },
      probes: {
        [`${brew} --prefix --installed ${formula}`]: probe(formulaPrefix),
        [`${brew} --caskroom ${formula}`]: probe("", 1),
        [`${brew} info --json=v2 ${formula}`]: probe(
          JSON.stringify({
            formulae: [
              {
                installed: [{ version: "1.2.3" }],
                versions: { stable: "1.2.4" },
              },
            ],
          }),
        ),
      },
    }),
    tapCatalog,
  ).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Managed by Homebrew",
        ownershipVerified: true,
        update: { executable: brew, args: ["upgrade", formula] },
      });
    }),
  );
});

it.effect("accepts Homebrew cask metadata with a scalar installed version", () => {
  const brew = "/opt/homebrew/bin/brew";
  const caskPrefix = "/opt/homebrew/Caskroom/codex";
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: "/opt/homebrew/bin/codex",
    realCommandPath: `${caskPrefix}/0.149.1/codex-aarch64-apple-darwin`,
    commands: { brew },
    probes: {
      [`${brew} --prefix --installed codex`]: probe("", 1),
      [`${brew} --caskroom codex`]: probe(caskPrefix),
      [`${brew} info --json=v2 codex`]: probe(
        JSON.stringify({
          casks: [{ installed: "0.149.1", version: "0.150.0" }],
        }),
      ),
    },
  }).pipe(
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

it.effect("normalizes Homebrew cask build suffixes as channel metadata", () => {
  const brew = "/opt/homebrew/bin/brew";
  const caskPrefix = "/opt/homebrew/Caskroom/codex";
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: "/opt/homebrew/bin/codex",
    realCommandPath: `${caskPrefix}/1.2.3,4566/codex-aarch64-apple-darwin`,
    commands: { brew },
    probes: {
      [`${brew} --prefix --installed codex`]: probe("", 1),
      [`${brew} --caskroom codex`]: probe(caskPrefix),
      [`${brew} info --json=v2 codex`]: probe(
        JSON.stringify({
          casks: [{ installed: "1.2.3,4566", version: "1.2.3,4567" }],
        }),
      ),
    },
  }).pipe(
    Effect.map((installation) => {
      expect(installation).toMatchObject({
        label: "Managed by Homebrew",
        currentVersion: "1.2.3",
        latestVersion: "1.2.3",
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
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: "/opt/homebrew/bin/codex",
    realCommandPath: `${caskPrefix}/0.149.1/codex-aarch64-apple-darwin`,
    commands: { brew },
    realPaths: { [formulaPrefix]: realFormulaPrefix },
    probes: {
      [`${brew} --prefix --installed codex`]: probe(formulaPrefix),
      [`${brew} --caskroom codex`]: probe(caskPrefix),
      [`${brew} info --json=v2 codex`]: probe(
        JSON.stringify({
          formulae: [
            {
              installed: [{ version: "9.0.0" }],
              versions: { stable: "9.1.0" },
            },
          ],
          casks: [{ installed: ["0.149.1"], version: "0.150.0" }],
        }),
      ),
    },
  }).pipe(
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
  return resolveCatalog({
    binaryPath: "codex",
    resolvedCommandPath: "/opt/homebrew/bin/codex",
    realCommandPath: `${caskPrefix}/0.150.0/codex-aarch64-apple-darwin`,
    commands: { brew },
    probes: {
      [`${brew} --prefix --installed ${formula}`]: probe("", 1),
      [`${brew} --caskroom ${formula}`]: probe(caskPrefix),
      [`${brew} info --json=v2 ${formula}`]: probe(
        JSON.stringify({
          casks: [{ installed: "0.150.0", version: "0.151.0" }],
        }),
      ),
    },
  }).pipe(
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
  resolveCatalog({
    binaryPath: "/custom/bin/codex",
    resolvedCommandPath: "/custom/bin/codex",
    commands: { npm: "/usr/local/bin/npm" },
  }).pipe(
    Effect.map((installation) => {
      expectManualInstallation(installation);
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
    [`${reg} query HKCU\\${uninstall} /s /f OpenAI.Codex /d /e /reg:64`]: probe(key),
    [`${reg} query HKLM\\${uninstall} /s /f OpenAI.Codex /d /e /reg:64`]: probe("", 1),
    [`${reg} query HKLM\\${uninstall} /s /f OpenAI.Codex /d /e /reg:32`]: probe("", 1),
    [`${reg} query ${key} /reg:64`]: probe(
      `${key}\n    DisplayVersion    REG_SZ    1.0.0\n    WinGetPackageIdentifier    REG_SZ    OpenAI.Codex\n    WinGetSourceIdentifier    REG_SZ    Microsoft.Winget.Source_8wekyb3d8bbwe\n    SymlinkFullPath    REG_SZ    ${link}\n    TargetFullPath    REG_SZ    ${target}`,
    ),
    [`${winget} source export --disable-interactivity`]: probe(
      '{"Data":"Microsoft.Winget.Source_8wekyb3d8bbwe","Identifier":"Microsoft.Winget.Source_8wekyb3d8bbwe","Name":"winget"}',
    ),
    [`${winget} show --id OpenAI.Codex --exact --source winget --versions --accept-source-agreements --disable-interactivity`]:
      probe("Version\n-------\n1.1.0\n1.0.0"),
  };
  const showKey = `${winget} show --id OpenAI.Codex --exact --source winget --versions --accept-source-agreements --disable-interactivity`;
  const resolve = (resolvedProbes: Readonly<Record<string, MaintenanceProbeResult>>) =>
    resolveCatalog({
      binaryPath: "codex",
      resolvedCommandPath: link,
      realCommandPath: target,
      platform: "win32",
      commands: { winget },
      probes: resolvedProbes,
    });
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
      [showKey]: probe("Version\n-------\n1.0.0\n1.1.0"),
    });
    expect(ascendingVersions.latestVersion).toBe("1.1.0");
    const failedShow = yield* resolve({
      ...probes,
      [showKey]: probe("Error 1.9.0", 1, "source unavailable"),
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
