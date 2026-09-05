import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const {
  appendSwitchMock,
  getSwitchValueMock,
  hasSwitchMock,
  registerSchemesMock,
  packagedState,
  readFileMock,
} = vi.hoisted(() => ({
  appendSwitchMock: vi.fn(),
  getSwitchValueMock: vi.fn(),
  hasSwitchMock: vi.fn(),
  registerSchemesMock: vi.fn(),
  readFileMock: vi.fn(),
  packagedState: { value: false },
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: readFileMock,
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return packagedState.value;
    },
    getAppPath: () => "/packaged-app",
    getVersion: () => "1.2.3",
    getName: () => "T3 Code (Fork)",
    commandLine: {
      appendSwitch: appendSwitchMock,
      getSwitchValue: getSwitchValueMock,
      hasSwitch: hasSwitchMock,
    },
  },
  protocol: {
    registerSchemesAsPrivileged: registerSchemesMock,
  },
}));

import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";

describe("DesktopPreReadyPlatform", () => {
  beforeEach(() => {
    appendSwitchMock.mockReset();
    getSwitchValueMock.mockReset();
    hasSwitchMock.mockReset();
    registerSchemesMock.mockReset();
    readFileMock.mockReset();
    packagedState.value = false;
  });

  it("reads an explicit Electron command-line switch value", () => {
    const value = DesktopPreReadyPlatform.readCommandLineSwitchValue(
      {
        hasSwitch: (switchName) => switchName === "password-store",
        getSwitchValue: (switchName) => {
          assert.equal(switchName, "password-store");
          return "basic";
        },
      },
      "password-store",
    );

    assert.equal(value, "basic");
  });

  it("treats valueless Electron command-line switches as absent", () => {
    const value = DesktopPreReadyPlatform.readCommandLineSwitchValue(
      {
        hasSwitch: () => true,
        getSwitchValue: () => "",
      },
      "password-store",
    );

    assert.isNull(value);
  });

  it("returns null for missing Electron command-line switches", () => {
    const value = DesktopPreReadyPlatform.readCommandLineSwitchValue(
      {
        hasSwitch: () => false,
        getSwitchValue: () => {
          throw new Error("Unexpected switch value read.");
        },
      },
      "password-store",
    );

    assert.isNull(value);
  });

  it("retains legacy packaged identity and rejects malformed metadata", () => {
    packagedState.value = true;
    readFileMock.mockReturnValue("{}");
    assert.equal(
      DesktopPreReadyPlatform.resolveEarlyDesktopSchemeFromProcess(),
      "t3code-fork-8e5b1a73152cf01c1ce614f31711fc4159e8ecc177cd4c02975ed0145b3d3d45",
    );
    readFileMock.mockReturnValue('{"t3codeDesktopIdentity": {"distributionId": 42}}');
    assert.throws(() => DesktopPreReadyPlatform.resolveEarlyDesktopSchemeFromProcess());
    assert.equal(registerSchemesMock.mock.calls.length, 0);
  });

  it.effect("registers the packaged fork scheme during synchronous pre-ready setup", () =>
    Effect.gen(function* () {
      packagedState.value = true;
      readFileMock.mockReturnValue(
        '{"t3codeDesktopIdentity":{"appId":"com.t3tools.t3code.fork-abc","packageName":"t3code-fork-abc","productName":"T3 Code (Fork)","displayName":"T3 Code (Fork Alpha)","distributionName":"Fork","distributionId":"fork-abc"}}',
      );
      yield* DesktopPreReadyPlatform.DesktopPreReadyElectronOptions.pipe(
        Effect.provide(DesktopPreReadyPlatform.layer),
        Effect.provideService(HostProcessPlatform, "darwin"),
      );
      assert.deepEqual(readFileMock.mock.calls, [["/packaged-app/package.json", "utf8"]]);
      assert.equal(registerSchemesMock.mock.calls.length, 1);
      assert.deepInclude(registerSchemesMock.mock.calls[0]![0], {
        scheme: "t3code-fork-abc",
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true,
        },
      });
    }),
  );

  it.effect("uses the packaged distribution name for the Linux window class", () =>
    Effect.gen(function* () {
      packagedState.value = true;
      readFileMock.mockReturnValue(
        '{"t3codeDesktopIdentity":{"appId":"com.t3tools.t3code.fork-abc","packageName":"t3code-fork-abc","productName":"T3 Code (Fork)","displayName":"T3 Code (Fork Alpha)","distributionName":"Fork","distributionId":"fork-abc"}}',
      );

      yield* DesktopPreReadyPlatform.DesktopPreReadyElectronOptions.pipe(
        Effect.provide(DesktopPreReadyPlatform.layer),
        Effect.provideService(HostProcessPlatform, "linux"),
      );

      assert.deepEqual(appendSwitchMock.mock.calls[0], ["class", "t3code-fork-abc"]);
    }),
  );

  it.effect(
    "acquires a synchronous pre-ready layer before an asynchronous Clerk-shaped layer",
    () =>
      Effect.gen(function* () {
        class ClerkShaped extends Context.Service<ClerkShaped, { readonly ready: true }>()(
          "@t3tools/desktop/app/DesktopPreReadyPlatform.test/ClerkShaped",
        ) {}

        const events: Array<string> = [];
        registerSchemesMock.mockImplementation(() => {
          events.push("pre-ready");
        });

        const preReadyLayer = DesktopPreReadyPlatform.layer.pipe(
          Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")),
        );

        const clerkShapedLayer = Layer.effect(
          ClerkShaped,
          Effect.promise(() => Promise.resolve()).pipe(
            Effect.map(() => {
              events.push("clerk");
              return { ready: true as const };
            }),
          ),
        );

        const runtimeLayer = clerkShapedLayer.pipe(
          Layer.flatMap((clerkContext) => Layer.succeedContext(clerkContext)),
          Layer.provideMerge(preReadyLayer),
        );

        const result = yield* Effect.all({
          clerk: ClerkShaped,
          preReady: DesktopPreReadyPlatform.DesktopPreReadyElectronOptions,
        }).pipe(Effect.provide(runtimeLayer));

        assert.deepEqual(result, {
          clerk: { ready: true },
          preReady: {
            linux: null,
            linuxPasswordStoreCommandLine: null,
          },
        });
        assert.deepEqual(events, ["pre-ready", "clerk"]);
        assert.equal(registerSchemesMock.mock.calls.length, 1);
        assert.equal(appendSwitchMock.mock.calls.length, 0);
      }),
  );
});
