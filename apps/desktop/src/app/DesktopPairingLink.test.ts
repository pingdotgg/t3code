import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it, vi } from "vite-plus/test";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const { appOnMock } = vi.hoisted(() => ({ appOnMock: vi.fn() }));

vi.mock("electron", () => ({ app: { on: appOnMock } }));

import * as DesktopPairingLink from "./DesktopPairingLink.ts";

const link = "t3code://pair?host=https%3A%2F%2Fbackend.example.com&label=Work#token=ABCD1234";
const otherLink = "t3code://pair?host=https%3A%2F%2Fother.example.com#token=WXYZ5678";

describe("extractPairingLink", () => {
  const { extractPairingLink } = DesktopPairingLink;

  it("finds the pairing link among launcher argv noise", () => {
    expect(
      extractPairingLink(["/usr/bin/t3code", "--no-sandbox", link, "--foo=bar"], "t3code"),
    ).toBe(link);
  });

  it("returns null when no candidate is a pairing link", () => {
    expect(extractPairingLink(["/usr/bin/t3code", "--no-sandbox"], "t3code")).toBeNull();
    expect(extractPairingLink([], "t3code")).toBeNull();
  });

  it("ignores links on another scheme", () => {
    expect(extractPairingLink([link], "t3code-dev")).toBeNull();
    expect(
      extractPairingLink(["https://backend.example.com/pair#token=ABCD1234"], "t3code"),
    ).toBeNull();
  });

  it("ignores the renderer origin and unknown hosts on the same scheme", () => {
    expect(extractPairingLink(["t3code://app/"], "t3code")).toBeNull();
    expect(extractPairingLink(["t3code://app/settings?host=x#token=y"], "t3code")).toBeNull();
    expect(extractPairingLink(["t3code://other?host=x#token=y"], "t3code")).toBeNull();
  });

  it("matches the scheme case-insensitively and keeps the token fragment", () => {
    const result = extractPairingLink(["T3CODE://pair?host=h#token=t"], "t3code");
    expect(result).not.toBeNull();
    const url = new URL(result!);
    expect(url.host).toBe("pair");
    expect(url.searchParams.get("host")).toBe("h");
    expect(url.hash).toBe("#token=t");
  });

  it("skips malformed candidates without throwing", () => {
    expect(extractPairingLink(["t3code:", "t3code://", link], "t3code")).toBe(link);
  });
});

/** Builds the service against a fake Electron app whose open-url emitter we drive by hand. */
const makeScenario = () => {
  appOnMock.mockReset();
  const listeners = new Map<string, (...args: Array<unknown>) => void>();
  appOnMock.mockImplementation((eventName: string, listener: (...args: Array<unknown>) => void) => {
    listeners.set(eventName, listener);
  });
  const availableNotices = { count: 0 };
  const electronApp = {
    on: (eventName: string, listener: (...args: Array<unknown>) => void) =>
      Effect.sync(() => {
        listeners.set(eventName, listener);
      }),
  } as unknown as ElectronApp.ElectronApp["Service"];
  const desktopWindow = {
    dispatchPairingLinkAvailable: Effect.sync(() => {
      availableNotices.count += 1;
    }),
  } as unknown as DesktopWindow.DesktopWindow["Service"];
  const environment = {
    isDevelopment: false,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"];
  // Build the pre-ready open-url buffer first, as main.ts does, so the emitter
  // exists before the service.
  const layer = DesktopPairingLink.layer.pipe(
    Layer.provideMerge(DesktopPairingLink.layerOpenUrls),
    Layer.provide(Layer.succeed(ElectronApp.ElectronApp, electronApp)),
    Layer.provide(Layer.succeed(DesktopWindow.DesktopWindow, desktopWindow)),
    Layer.provide(Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment)),
  );
  const emit = (eventName: string, ...args: Array<unknown>) => {
    listeners.get(eventName)?.({}, ...args);
  };
  return { layer, emit, availableNotices };
};

/** The service notifies the renderer via a fire-and-forget promise; let it settle. */
const settle = Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)));

describe("DesktopPairingLink", () => {
  effectIt.effect("queues links in arrival order and hands them out once", () => {
    const scenario = makeScenario();
    return Effect.scoped(
      Effect.gen(function* () {
        const pairingLink = yield* DesktopPairingLink.DesktopPairingLink;
        yield* pairingLink.register;

        scenario.emit("open-url", link);
        scenario.emit("second-instance", ["/usr/bin/t3code", otherLink], "/");
        scenario.emit("open-url", "t3code://app/");
        yield* settle;

        assert.deepEqual(yield* pairingLink.takePending, [link, otherLink]);
        assert.deepEqual(yield* pairingLink.takePending, []);
        assert.equal(scenario.availableNotices.count, 2);
      }),
    ).pipe(Effect.provide(scenario.layer));
  });

  effectIt.effect("keeps an open-url that fires before the service registers", () => {
    const scenario = makeScenario();
    return Effect.scoped(
      Effect.gen(function* () {
        // The Electron listener exists as soon as the layer is built.
        scenario.emit("open-url", link);

        const pairingLink = yield* DesktopPairingLink.DesktopPairingLink;
        assert.deepEqual(yield* pairingLink.takePending, []);

        yield* pairingLink.register;
        yield* settle;

        assert.deepEqual(yield* pairingLink.takePending, [link]);
      }),
    ).pipe(Effect.provide(scenario.layer));
  });
});
