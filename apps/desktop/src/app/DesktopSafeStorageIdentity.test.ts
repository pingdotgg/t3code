// @effect-diagnostics nodeBuiltinImport:off - `node:crypto` writes OSCrypt payloads the way Chromium does.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { beforeEach, vi } from "vite-plus/test";

import { LinuxBrowserSecretPath } from "../preview/BrowserImport/LinuxBrowserSecret.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopSafeStorageIdentity from "./DesktopSafeStorageIdentity.ts";

const { getPassword, keychainEntries } = vi.hoisted(() => ({
  getPassword: vi.fn<() => string | null>(),
  keychainEntries: [] as Array<readonly [string, string]>,
}));

vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    constructor(service: string, account: string) {
      keychainEntries.push([service, account]);
    }
    getPassword = getPassword;
  },
}));

beforeEach(() => {
  getPassword.mockReset();
  keychainEntries.length = 0;
});

const catalog = '{"schemaVersion":1,"targets":[]}';

const encryptLikeChromium = (prefix: "v10" | "v11", secret: string, iterations: number) => {
  const key = NodeCrypto.pbkdf2Sync(secret, "saltysalt", iterations, 16, "sha1");
  const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  return Buffer.concat([Buffer.from(prefix), cipher.update(catalog, "utf8"), cipher.final()]);
};

const layerSecretHelper = (secrets: Readonly<Record<string, string>>) =>
  Layer.merge(
    Layer.succeed(LinuxBrowserSecretPath, "/bundled/browser-secret/t3-browser-secret"),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const application = command._tag === "StandardCommand" ? command.args[0] : undefined;
        const secret = application === undefined ? undefined : secrets[application];
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(secret === undefined ? 2 : 0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(secret ?? "")),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      }),
    ),
  );

const layerFor = (platform: NodeJS.Platform, secrets: Readonly<Record<string, string>> = {}) =>
  DesktopSafeStorageIdentity.layer.pipe(
    Layer.provide(
      DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/src",
        homeDirectory: "/home/test",
        platform,
        processArch: "x64",
        appVersion: "0.1.0",
        appPath: "/repo",
        isPackaged: true,
        resourcesPath: "/missing/resources",
        runningUnderArm64Translation: false,
      }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({})))),
    ),
    Layer.provide(layerSecretHelper(secrets)),
  );

describe("DesktopSafeStorageIdentity", () => {
  it.each([
    { appVersion: "0.1.0", name: "T3 Code (Alpha)", previousNames: ["T3 Code (Beta)"] },
    {
      appVersion: "0.1.1-preview.20261017.3",
      name: "T3 Code (Alpha)",
      previousNames: ["T3 Code (Beta)"],
    },
    { appVersion: "0.1.1-nightly.20261017.3", name: "T3 Code (Nightly)", previousNames: [] },
  ])("keeps $appVersion on the name its earlier builds encrypted with", (input) => {
    assert.deepStrictEqual(
      DesktopSafeStorageIdentity.resolveSafeStorageIdentity(input.appVersion),
      {
        name: input.name,
        previousNames: input.previousNames,
      },
    );
  });

  it.effect("decrypts Linux keyring data written under the Beta name", () =>
    Effect.gen(function* () {
      const identity = yield* DesktopSafeStorageIdentity.DesktopSafeStorageIdentity;
      const encrypted = encryptLikeChromium("v11", "beta-secret", 1);

      assert.deepStrictEqual(
        yield* identity.decryptWithPreviousName(encrypted),
        Option.some(catalog),
      );
    }).pipe(
      Effect.provide(
        layerFor("linux", { "T3 Code (Alpha)": "alpha-secret", "T3 Code (Beta)": "beta-secret" }),
      ),
    ),
  );

  it.effect("decrypts macOS Keychain data written under the Beta name", () =>
    Effect.gen(function* () {
      getPassword.mockReturnValue("beta-secret");
      const identity = yield* DesktopSafeStorageIdentity.DesktopSafeStorageIdentity;
      const encrypted = encryptLikeChromium("v10", "beta-secret", 1003);

      assert.deepStrictEqual(
        yield* identity.decryptWithPreviousName(encrypted),
        Option.some(catalog),
      );
      assert.deepStrictEqual(keychainEntries, [["T3 Code (Beta) Safe Storage", "T3 Code (Beta)"]]);
    }).pipe(Effect.provide(layerFor("darwin"))),
  );

  it.effect("finds nothing when the previous name has no key", () =>
    Effect.gen(function* () {
      const identity = yield* DesktopSafeStorageIdentity.DesktopSafeStorageIdentity;
      const encrypted = encryptLikeChromium("v11", "beta-secret", 1);

      assert.deepStrictEqual(yield* identity.decryptWithPreviousName(encrypted), Option.none());
    }).pipe(Effect.provide(layerFor("linux", { "T3 Code (Alpha)": "alpha-secret" }))),
  );
});
