import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopGatewayHeaders from "./DesktopGatewayHeaders.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function layerSafeStorageFor(available: boolean) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(available),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
    decryptString: (value) => Effect.succeed(textDecoder.decode(value).slice("encrypted:".length)),
    selectedStorageBackend: Effect.succeedNone,
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

interface HookCall {
  readonly urls: ReadonlyArray<string> | null;
  readonly rewrite: (url: string, headers: Record<string, string>) => Record<string, string>;
}

const withGatewayHeaders = <A, E>(
  use: (input: {
    readonly start: () => Effect.Effect<
      DesktopGatewayHeaders.DesktopGatewayHeaders["Service"],
      never,
      never
    >;
    readonly calls: Array<HookCall>;
    readonly filePath: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem>,
  encryptionAvailable = true,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-gateway-headers-test-",
    });
    const layerDependencies = Layer.mergeAll(
      DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/src",
        homeDirectory: baseDir,
        platform: "darwin",
        processArch: "arm64",
        appVersion: "1.2.3",
        appPath: "/repo",
        isPackaged: true,
        resourcesPath: "/missing/resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
        ),
      ),
      layerSafeStorageFor(encryptionAvailable),
      NodeServices.layer,
    );
    const calls: Array<HookCall> = [];
    const start = () =>
      DesktopGatewayHeaders.make((urls, rewrite) => calls.push({ urls, rewrite })).pipe(
        Effect.tap((service) => service.install),
        Effect.provide(layerDependencies),
        Effect.orDie,
      );
    const { stateDir } = yield* DesktopEnvironment.DesktopEnvironment.pipe(
      Effect.provide(layerDependencies),
    );
    return yield* use({ start, calls, filePath: `${stateDir}/gateway-headers.bin` });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const serviceToken = [
  { name: "CF-Access-Client-Id", value: "client-id" },
  { name: "CF-Access-Client-Secret", value: "client-secret" },
];

describe("DesktopGatewayHeaders", () => {
  it("adds headers only to requests for the saved origin, including its WebSocket", () => {
    const entries = [{ origin: "https://code.example.com", headers: serviceToken }];
    const base = { Accept: "*/*" };

    assert.deepStrictEqual(
      DesktopGatewayHeaders.withGatewayHeaders(
        entries,
        "wss://code.example.com/ws?wsTicket=x",
        base,
      ),
      {
        Accept: "*/*",
        "CF-Access-Client-Id": "client-id",
        "CF-Access-Client-Secret": "client-secret",
      },
    );
    for (const url of [
      "https://code.example.com.evil.test/api",
      "https://code.example.com:8443/api",
      "http://code.example.com/api",
      "https://other.example.com/api",
    ]) {
      assert.strictEqual(DesktopGatewayHeaders.withGatewayHeaders(entries, url, base), base, url);
    }
    assert.deepStrictEqual(DesktopGatewayHeaders.gatewayUrlPatterns(["https://code.example.com"]), [
      "https://code.example.com/*",
      "wss://code.example.com/*",
    ]);
  });

  it.effect("persists headers across restarts and stops adding them once removed", () =>
    withGatewayHeaders(({ start, calls }) =>
      Effect.gen(function* () {
        const first = yield* start();
        assert.deepStrictEqual(calls.at(-1)?.urls, null);

        const saved = yield* first.set({
          origin: "https://code.example.com/some/path?pairing=1",
          headers: serviceToken,
        });
        assert.deepStrictEqual(saved, [
          {
            origin: "https://code.example.com",
            headerNames: ["CF-Access-Client-Id", "CF-Access-Client-Secret"],
          },
        ]);

        const second = yield* start();
        assert.deepStrictEqual(yield* second.list, saved);
        const restored = calls.at(-1)!;
        assert.deepStrictEqual(restored.urls, [
          "https://code.example.com/*",
          "wss://code.example.com/*",
        ]);
        assert.strictEqual(
          restored.rewrite("https://code.example.com/oauth/token", {})["CF-Access-Client-Secret"],
          "client-secret",
        );

        assert.deepStrictEqual(yield* second.remove("wss://code.example.com/ws"), []);
        assert.deepStrictEqual(calls.at(-1)?.urls, null);
        assert.deepStrictEqual(yield* (yield* start()).list, []);
      }),
    ),
  );

  it.effect("leaves a saved file it cannot read untouched", () =>
    withGatewayHeaders(({ start, filePath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* (yield* start()).set({ origin: "https://code.example.com", headers: serviceToken });
        yield* fileSystem.writeFileString(filePath, "unreadable");

        const restarted = yield* start();
        assert.deepStrictEqual(yield* restarted.list, []);
        const error = yield* Effect.flip(
          restarted.set({ origin: "https://other.example.com", headers: serviceToken }),
        );
        assert.strictEqual(error.reason, "read-failed");
        assert.strictEqual(yield* fileSystem.readFileString(filePath), "unreadable");
      }),
    ),
  );

  it.effect("refuses to save when secure storage is unavailable", () =>
    withGatewayHeaders(
      ({ start }) =>
        Effect.gen(function* () {
          const service = yield* start();
          const error = yield* Effect.flip(
            service.set({ origin: "https://code.example.com", headers: serviceToken }),
          );
          assert.strictEqual(error.reason, "encryption-unavailable");
          assert.deepStrictEqual(yield* service.list, []);
        }),
      false,
    ),
  );
});
