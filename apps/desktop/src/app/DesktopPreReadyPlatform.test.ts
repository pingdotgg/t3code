import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const { appendSwitchMock, getSwitchValueMock, hasSwitchMock, registerSchemesMock } = vi.hoisted(
  () => ({
    appendSwitchMock: vi.fn(),
    getSwitchValueMock: vi.fn(),
    hasSwitchMock: vi.fn(),
    registerSchemesMock: vi.fn(),
  }),
);

vi.mock("electron", () => ({
  app: {
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
