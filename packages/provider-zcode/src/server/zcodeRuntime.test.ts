// @effect-diagnostics nodeBuiltinImport:off -- tests craft the CLI's own AES-GCM store values with node crypto
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  resolveZcodeCatalogFiles,
  readZcodeAppVersion,
  resolveZcodeLaunchCommand,
  zcodeBuiltinCatalogPath,
  zcodeBundledCatalogPath,
  zcodeBaseUrl,
  zcodeDataRoot,
  zcodeModelSelectionFromSlug,
  zcodePersonalProviderConfigPath,
  zcodePlatformDir,
  zcodeRuntimeEnvironment,
  zcodeServeArgs,
} from "./zcodeRuntime.ts";

// Verified against the on-disk zcode 3.17.2 runtime catalog directory for https://zcode.z.ai.
const ZCODE_ENDPOINT_HASH = "78d7c3bef4024722642626fe3669a799";

const inlineCatalog = {
  schemaVersion: 1,
  revision: 43,
  config: {
    providerConfigRules: {
      templateRules: [
        {
          templateId: "zai-api",
          config: { access: { type: "api-key" }, builtinModelIds: ["GLM-5.3"] },
        },
      ],
      providerRules: [
        {
          providerId: "account:zai-individual-coding-plan",
          config: {
            access: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "zai" },
            builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"],
          },
        },
        {
          providerId: "account:zai-team-coding-plan",
          config: {
            access: { type: "zhipu-account", mode: "team-coding-plan", accountType: "zai" },
            builtinModelIds: ["GLM-5.3"],
          },
        },
        {
          providerId: "account:bigmodel-individual-coding-plan",
          config: {
            access: {
              type: "zhipu-account",
              mode: "individual-coding-plan",
              accountType: "bigmodel",
            },
            builtinModelIds: ["GLM-5.3"],
          },
        },
        {
          providerId: "account:start-individual-coding-plan",
          config: {
            access: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "start" },
            builtinModelIds: ["GLM-5.3-Flash"],
          },
        },
        {
          providerId: "kimi-api",
          config: { access: { type: "api-key" }, builtinModelIds: ["kimi-k3"] },
        },
        {
          providerId: "broken-empty-models",
          config: { access: { type: "zhipu-account" }, builtinModelIds: [] },
        },
      ],
    },
  },
};

describe("zcodePlatformDir", () => {
  it("maps zcode's own platform spellings", () => {
    assert.equal(zcodePlatformDir("linux", "x64"), "linux-x86_64");
    assert.equal(zcodePlatformDir("darwin", "x64"), "darwin-x64");
    assert.equal(zcodePlatformDir("darwin", "arm64"), "darwin-arm64");
    assert.equal(zcodePlatformDir("win32", "x64"), "win32-x64");
  });

  it("returns undefined where zcode has no runtime catalog", () => {
    assert.equal(zcodePlatformDir("linux", "arm64"), undefined);
    assert.equal(zcodePlatformDir("win32", "arm64"), undefined);
    assert.equal(zcodePlatformDir("freebsd", "x64"), undefined);
  });
});

describe("zcodeBuiltinCatalogPath", () => {
  it("keys the CDN-refreshed catalog on the endpoint-origin sha256 prefix", () => {
    assert.equal(
      zcodeBuiltinCatalogPath({
        root: "/home/dev",
        appVersion: "3.17.2",
        platform: "linux",
        arch: "x64",
      }),
      `/home/dev/.zcode/v2/runtime/provider/linux-x86_64/3.17.2/endpoint-${ZCODE_ENDPOINT_HASH}/zcode-builtin.json`,
    );
    assert.equal(
      zcodeBuiltinCatalogPath({
        root: "C:\\d",
        appVersion: "3.17.2",
        platform: "win32",
        arch: "x64",
      }),
      `C:\\d/.zcode/v2/runtime/provider/win32-x64/3.17.2/endpoint-${ZCODE_ENDPOINT_HASH}/zcode-builtin.json`,
    );
  });

  it("keys an overridden endpoint's catalog on its normalized origin", () => {
    const originHash = NodeCrypto.createHash("sha256")
      .update("https://proxy.example")
      .digest("hex")
      .slice(0, 32);
    assert.equal(
      zcodeBuiltinCatalogPath({
        root: "/home/dev",
        appVersion: "3.17.2",
        platform: "linux",
        arch: "x64",
        baseUrl: "https://proxy.example/team/",
      }),
      `/home/dev/.zcode/v2/runtime/provider/linux-x86_64/3.17.2/endpoint-${originHash}/zcode-builtin.json`,
    );
  });

  it("derives the bundled and personal paths from the data root", () => {
    assert.equal(
      zcodeBundledCatalogPath("/home/dev"),
      "/home/dev/.zcode/v2/runtime/provider/bundled/zcode-builtin.json",
    );
    assert.equal(
      zcodePersonalProviderConfigPath("/home/dev"),
      "/home/dev/.zcode/v2/provider_config.json",
    );
    assert.equal(zcodeDataRoot({ HOME: "/home/dev" }), "/home/dev");
    assert.equal(zcodeDataRoot({ ZCODE_DATA_BASE_DIR: " /tmp/z ", HOME: "/home/dev" }), "/tmp/z");
    // Windows runs without HOME or ZCODE_DATA_BASE_DIR; the OS home keeps catalog discovery alive.
    assert.equal(zcodeDataRoot({}), NodeOS.homedir());
    assert.equal(zcodeDataRoot({ ZCODE_DATA_BASE_DIR: "   ", HOME: "" }), NodeOS.homedir());
  });
});

describe("zcodeServeArgs", () => {
  it("launches serve with launch args split on whitespace", () => {
    assert.deepEqual(zcodeServeArgs(""), ["serve"]);
    assert.deepEqual(zcodeServeArgs("--verbose   --trace file  "), [
      "serve",
      "--verbose",
      "--trace",
      "file",
    ]);
  });
});

describe("resolveZcodeLaunchCommand", () => {
  it.effect("explicit binaryPath wins over every fallback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const command = yield* resolveZcodeLaunchCommand(
        { binaryPath: "/opt/bin/zcode" },
        { HOME: "/home/dev" },
        fileSystem,
      );
      assert.equal(command, "/opt/bin/zcode");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to the desktop shim when zcode is off PATH", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectory();
      yield* fileSystem.makeDirectory(`${home}/.zcode/server/bin`, { recursive: true });
      yield* fileSystem.writeFileString(`${home}/.zcode/server/bin/zcode`, "#!/bin/sh\n");
      // binaryPath decodes to the bare fallback when the user leaves the field empty.
      const command = yield* resolveZcodeLaunchCommand(
        { binaryPath: "zcode" },
        { HOME: home, PATH: "/nonexistent" },
        fileSystem,
      );
      assert.equal(command, `${home}/.zcode/server/bin/zcode`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("probes the Windows desktop shim as zcode.cmd when zcode is off PATH", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectory();
      yield* fileSystem.makeDirectory(`${home}/.zcode/server/bin`, { recursive: true });
      yield* fileSystem.writeFileString(`${home}/.zcode/server/bin/zcode.cmd`, "@echo off\n");
      const command = yield* resolveZcodeLaunchCommand(
        { binaryPath: "zcode" },
        { HOME: home, PATH: "C:\\nonexistent" },
        fileSystem,
      );
      assert.equal(command, `${home}/.zcode/server/bin/zcode.cmd`);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect(
    "keeps the plain binary name on Windows when the shim dir only holds a bare zcode",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectory();
        yield* fileSystem.makeDirectory(`${home}/.zcode/server/bin`, { recursive: true });
        yield* fileSystem.writeFileString(`${home}/.zcode/server/bin/zcode`, "#!/bin/sh\n");
        const command = yield* resolveZcodeLaunchCommand(
          { binaryPath: "" },
          { HOME: home, PATH: "C:\\nonexistent" },
          fileSystem,
        );
        assert.equal(command, "zcode");
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provide(NodeServices.layer),
      ),
  );

  it.effect("keeps the plain binary name when no fallback exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const command = yield* resolveZcodeLaunchCommand(
        { binaryPath: "" },
        { HOME: "/nonexistent-home", PATH: "/nonexistent" },
        fileSystem,
      );
      assert.equal(command, "zcode");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("prefers a colon-separated PATH hit over the desktop shim on POSIX", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectory();
      yield* fileSystem.makeDirectory(`${home}/.zcode/server/bin`, { recursive: true });
      yield* fileSystem.writeFileString(`${home}/.zcode/server/bin/zcode`, "#!/bin/sh\n");
      const onPath = yield* fileSystem.makeTempDirectory();
      yield* fileSystem.writeFileString(`${onPath}/zcode`, "#!/bin/sh\n");
      const command = yield* resolveZcodeLaunchCommand(
        { binaryPath: "zcode" },
        { HOME: home, PATH: `${onPath}:/nonexistent` },
        fileSystem,
      );
      assert.equal(command, "zcode");
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("splits PATH on ; on Windows so a PATH install beats the desktop shim", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectory();
      yield* fileSystem.makeDirectory(`${home}/.zcode/server/bin`, { recursive: true });
      yield* fileSystem.writeFileString(`${home}/.zcode/server/bin/zcode`, "#!/bin/sh\n");
      const onPath = yield* fileSystem.makeTempDirectory();
      yield* fileSystem.writeFileString(`${onPath}/zcode.exe`, "binary");
      const command = yield* resolveZcodeLaunchCommand(
        { binaryPath: "zcode" },
        { HOME: home, PATH: `C:\\nonexistent;${onPath}` },
        fileSystem,
      );
      assert.equal(command, "zcode");
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(NodeServices.layer),
    ),
  );
});

describe("zcodeRuntimeEnvironment", () => {
  it("always points the CLI at the endpoint origin", () => {
    const env = zcodeRuntimeEnvironment({ HOME: "/home/dev", KEEP: "1" }, {});
    assert.equal(env.ZCODE_BASE_URL, "https://zcode.z.ai");
    assert.equal(env.KEEP, "1");
    assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, undefined);
    assert.equal(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, undefined);
  });

  it("honors a configured endpoint and normalizes it to an origin", () => {
    const env = zcodeRuntimeEnvironment(
      { HOME: "/home/dev", ZCODE_BASE_URL: " https://proxy.example/team/ " },
      {},
    );
    assert.equal(env.ZCODE_BASE_URL, "https://proxy.example");
    // Unparseable values keep their text so the catalog lookup fails honestly.
    assert.equal(zcodeBaseUrl({ ZCODE_BASE_URL: "not a url" }), "not a url");
  });

  it("emits catalog env vars only for files that exist", () => {
    const env = zcodeRuntimeEnvironment(
      {},
      {
        builtinPath: "/data/builtin.json",
        bundledPath: "/data/bundled.json",
        personalPath: "/data/personal.json",
      },
    );
    assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, "/data/builtin.json");
    assert.equal(env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE, "/data/bundled.json");
    assert.equal(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, "/data/personal.json");
  });

  it("drops the bundled var and the paired personal var when those files are missing", () => {
    const env = zcodeRuntimeEnvironment({}, { builtinPath: "/data/builtin.json" });
    assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, "/data/builtin.json");
    assert.equal(env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE, undefined);
    assert.equal(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, undefined);
  });
});

describe("zcodeModelSelectionFromSlug", () => {
  it("defers default slugs to the CLI's own default", () => {
    assert.equal(zcodeModelSelectionFromSlug("default"), undefined);
    assert.equal(zcodeModelSelectionFromSlug("default$high"), undefined);
    assert.equal(zcodeModelSelectionFromSlug(""), undefined);
  });

  it("maps account provider slugs to zcode model selections", () => {
    assert.deepEqual(zcodeModelSelectionFromSlug("account:zai-individual-coding-plan/GLM-5.3"), {
      providerId: "account:zai-individual-coding-plan",
      modelId: "GLM-5.3",
    });
    assert.deepEqual(
      zcodeModelSelectionFromSlug("account:zai-individual-coding-plan/GLM-5.3-Flash$high"),
      {
        providerId: "account:zai-individual-coding-plan",
        modelId: "GLM-5.3-Flash",
        options: { reasoningLevel: "high" },
      },
    );
  });

  it("rejects slugs outside the account: provider namespace", () => {
    assert.equal(zcodeModelSelectionFromSlug("openai/gpt-5"), undefined);
    assert.equal(zcodeModelSelectionFromSlug("/GLM-5.3"), undefined);
    assert.equal(zcodeModelSelectionFromSlug("account:zai-individual-coding-plan/"), undefined);
    assert.equal(zcodeModelSelectionFromSlug("no-slash"), undefined);
  });
});

it.layer(NodeServices.layer)("ZcodeRuntime catalog resolution", (it) => {
  it.effect("reads the app version and emits only existing catalog files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-runtime-test-" });
        const platformDir = zcodePlatformDir(
          yield* HostProcess.Platform,
          yield* HostProcess.Architecture,
        );
        const currentPath = `${root}/.zcode/server/current.json`;
        const personalPath = zcodePersonalProviderConfigPath(root);

        // No server/current.json yet: only the personal file resolves.
        yield* fs.makeDirectory(`${root}/.zcode/v2`, { recursive: true });
        yield* fs.makeDirectory(`${root}/.zcode/server`, { recursive: true });
        yield* fs.writeFileString(personalPath, "{}");
        const withoutVersion = yield* resolveZcodeCatalogFiles(fs, {
          ZCODE_DATA_BASE_DIR: root,
        });
        assert.equal(withoutVersion.builtinPath, undefined);
        assert.equal(withoutVersion.personalPath, personalPath);

        if (platformDir === undefined) return;
        const builtinDir = `${root}/.zcode/v2/runtime/provider/${platformDir}/3.17.1/endpoint-${ZCODE_ENDPOINT_HASH}`;
        yield* fs.makeDirectory(builtinDir, { recursive: true });
        yield* fs.writeFileString(currentPath, '{"version":"3.17.1"}');
        yield* fs.writeFileString(
          `${builtinDir}/zcode-builtin.json`,
          JSON.stringify(inlineCatalog),
        );
        const resolved = yield* resolveZcodeCatalogFiles(fs, { ZCODE_DATA_BASE_DIR: root });
        assert.equal(resolved.builtinPath, `${builtinDir}/zcode-builtin.json`);
        assert.equal(resolved.bundledPath, undefined);
        assert.equal(resolved.personalPath, personalPath);
      }),
    ),
  );

  it.effect("resolves the catalog under the overridden endpoint directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-runtime-test-" });
        const platformDir = zcodePlatformDir(
          yield* HostProcess.Platform,
          yield* HostProcess.Architecture,
        );
        if (platformDir === undefined) return;
        const origin = "https://proxy.example";
        const endpointHash = NodeCrypto.createHash("sha256")
          .update(origin)
          .digest("hex")
          .slice(0, 32);
        yield* fs.makeDirectory(`${root}/.zcode/server`, { recursive: true });
        yield* fs.writeFileString(`${root}/.zcode/server/current.json`, '{"version":"3.17.1"}');
        const builtinDir = `${root}/.zcode/v2/runtime/provider/${platformDir}/3.17.1/endpoint-${endpointHash}`;
        yield* fs.makeDirectory(builtinDir, { recursive: true });
        yield* fs.writeFileString(
          `${builtinDir}/zcode-builtin.json`,
          JSON.stringify(inlineCatalog),
        );
        const resolved = yield* resolveZcodeCatalogFiles(fs, {
          ZCODE_DATA_BASE_DIR: root,
          ZCODE_BASE_URL: origin,
        });
        assert.equal(resolved.builtinPath, `${builtinDir}/zcode-builtin.json`);
      }),
    ),
  );

  it.effect("keeps an unreadable current.json from producing catalog env vars", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-runtime-test-" });
        yield* fs.makeDirectory(`${root}/.zcode/server`, { recursive: true });
        yield* fs.writeFileString(`${root}/.zcode/server/current.json`, "not-json");
        const resolved = yield* resolveZcodeCatalogFiles(fs, { ZCODE_DATA_BASE_DIR: root });
        assert.equal(resolved.builtinPath, undefined);
        assert.equal(resolved.personalPath, undefined);
      }),
    ),
  );

  it.effect("readZcodeAppVersion returns the pinned server version", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-runtime-test-" });
        yield* fs.makeDirectory(`${root}/.zcode/server`, { recursive: true });
        yield* fs.writeFileString(
          `${root}/.zcode/server/current.json`,
          '{"version":"3.17.2","releaseDir":"/x"}',
        );
        const version = yield* readZcodeAppVersion(fs, `${root}/.zcode/server/current.json`);
        assert.equal(version, "3.17.2");
        const missing = yield* readZcodeAppVersion(fs, `${root}/missing.json`);
        assert.equal(missing, undefined);
      }),
    ),
  );
});
