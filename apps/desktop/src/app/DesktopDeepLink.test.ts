import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import { DEEP_LINK_CHANNEL, DEEP_LINK_SUBSCRIBE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopDeepLink from "./DesktopDeepLink.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const ENVIRONMENT_ID = "0f0e2f21-8b4c-4c2a-9d59-3f0d1a2b3c4d";
const THREAD_ID = "aa11bb22-cc33-4d44-8e55-ff6677889900";
const OTHER_THREAD_ID = "bb22cc33-dd44-4e55-9f66-001122334455";
const PAYLOAD = { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID };

describe("parseThreadDeepLink", () => {
  it("parses a production-scheme thread link", () => {
    assert.deepEqual(
      DesktopDeepLink.parseThreadDeepLink(`t3code://app/${ENVIRONMENT_ID}/${THREAD_ID}`, "t3code"),
      PAYLOAD,
    );
  });

  it("parses a development-scheme thread link", () => {
    assert.deepEqual(
      DesktopDeepLink.parseThreadDeepLink(
        `t3code-dev://app/${ENVIRONMENT_ID}/${THREAD_ID}`,
        "t3code-dev",
      ),
      PAYLOAD,
    );
  });

  it("accepts uppercase UUIDs and normalizes them to lowercase", () => {
    assert.deepEqual(
      DesktopDeepLink.parseThreadDeepLink(
        `t3code://app/${ENVIRONMENT_ID.toUpperCase()}/${THREAD_ID.toUpperCase()}`,
        "t3code",
      ),
      PAYLOAD,
    );
  });

  it("rejects links for the other build's scheme", () => {
    const path = `app/${ENVIRONMENT_ID}/${THREAD_ID}`;
    assert.isNull(DesktopDeepLink.parseThreadDeepLink(`t3code-dev://${path}`, "t3code"));
    assert.isNull(DesktopDeepLink.parseThreadDeepLink(`t3code://${path}`, "t3code-dev"));
    assert.isNull(DesktopDeepLink.parseThreadDeepLink(`https://${path}`, "t3code"));
  });

  it("rejects hosts other than app", () => {
    assert.isNull(
      DesktopDeepLink.parseThreadDeepLink(`t3code://apps/${ENVIRONMENT_ID}/${THREAD_ID}`, "t3code"),
    );
    assert.isNull(
      DesktopDeepLink.parseThreadDeepLink(
        `t3code://oauth/${ENVIRONMENT_ID}/${THREAD_ID}`,
        "t3code",
      ),
    );
  });

  it("rejects wrong path segment counts", () => {
    assert.isNull(DesktopDeepLink.parseThreadDeepLink(`t3code://app/${ENVIRONMENT_ID}`, "t3code"));
    assert.isNull(
      DesktopDeepLink.parseThreadDeepLink(
        `t3code://app/${ENVIRONMENT_ID}/${THREAD_ID}/${THREAD_ID}`,
        "t3code",
      ),
    );
  });

  it("rejects non-UUID segments", () => {
    assert.isNull(
      DesktopDeepLink.parseThreadDeepLink(`t3code://app/settings/${THREAD_ID}`, "t3code"),
    );
    assert.isNull(
      DesktopDeepLink.parseThreadDeepLink(
        `t3code://app/${ENVIRONMENT_ID}/../${THREAD_ID}`,
        "t3code",
      ),
    );
    assert.isNull(
      DesktopDeepLink.parseThreadDeepLink(
        `t3code://app/${ENVIRONMENT_ID.slice(0, -1)}g/${THREAD_ID}`,
        "t3code",
      ),
    );
  });

  it("rejects query strings, fragments, and trailing slashes", () => {
    const valid = `t3code://app/${ENVIRONMENT_ID}/${THREAD_ID}`;
    assert.isNull(DesktopDeepLink.parseThreadDeepLink(`${valid}?utm_source=slack`, "t3code"));
    assert.isNull(DesktopDeepLink.parseThreadDeepLink(`${valid}#section`, "t3code"));
    assert.isNull(DesktopDeepLink.parseThreadDeepLink(`${valid}/`, "t3code"));
  });

  it("rejects OAuth callback URLs", () => {
    assert.isNull(
      DesktopDeepLink.parseThreadDeepLink("t3code://app/oauth/callback?code=abc123", "t3code"),
    );
  });
});

describe("findThreadDeepLinkInArgv", () => {
  it("finds the thread link among other argv entries", () => {
    assert.deepEqual(
      DesktopDeepLink.findThreadDeepLinkInArgv(
        ["/usr/bin/t3code", "--no-sandbox", `t3code://app/${ENVIRONMENT_ID}/${THREAD_ID}`],
        "t3code",
      ),
      PAYLOAD,
    );
  });

  it("returns null when argv carries no thread link", () => {
    assert.isNull(
      DesktopDeepLink.findThreadDeepLinkInArgv(
        ["/usr/bin/t3code", "--no-sandbox", "t3code://oauth/callback?code=abc123"],
        "t3code",
      ),
    );
  });
});

type AppListener = (...args: ReadonlyArray<unknown>) => void;
type IpcHandler = (raw: unknown, event: DesktopIpc.DesktopIpcInvokeEvent) => Effect.Effect<unknown>;

interface FakeSender {
  readonly sender: DesktopIpc.DesktopIpcSenderWebContents;
  readonly send: ReturnType<typeof vi.fn>;
  readonly isDestroyed: ReturnType<typeof vi.fn>;
  readonly destroy: () => void;
}

const makeSender = (id: number): FakeSender => {
  const send = vi.fn();
  const isDestroyed = vi.fn(() => false);
  const destroyedListeners: Array<() => void> = [];
  return {
    sender: {
      id,
      isDestroyed,
      send,
      once: (_event: "destroyed", listener: () => void) => {
        destroyedListeners.push(listener);
      },
    },
    send,
    isDestroyed,
    destroy: () => {
      isDestroyed.mockReturnValue(true);
      for (const listener of destroyedListeners) {
        listener();
      }
    },
  };
};

interface TestHarness {
  readonly listeners: Map<string, AppListener>;
  readonly ipcHandlers: Map<string, IpcHandler>;
  readonly revealed: unknown[];
  readonly window: unknown;
}

const makeHarness = (): TestHarness => ({
  listeners: new Map(),
  ipcHandlers: new Map(),
  revealed: [],
  window: { id: 1 },
});

const makeServices = (harness: TestHarness) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    isDevelopment: false,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  const electronApp = {
    on: (eventName: string, listener: AppListener) =>
      Effect.sync(() => {
        harness.listeners.set(eventName, listener);
      }),
  } as unknown as ElectronApp.ElectronApp["Service"];

  const electronWindow = {
    fromWebContentsId: (_webContentsId: number) => Effect.succeed(Option.some(harness.window)),
    reveal: (window: unknown) =>
      Effect.sync(() => {
        harness.revealed.push(window);
      }),
  } as unknown as ElectronWindow.ElectronWindow["Service"];

  const desktopIpc = {
    handle: (method: { channel: string; handler: IpcHandler }) =>
      Effect.sync(() => {
        harness.ipcHandlers.set(method.channel, method.handler);
      }),
  } as unknown as DesktopIpc.DesktopIpc["Service"];

  return {
    layer: DesktopDeepLink.layer.pipe(
      Layer.provide(Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment)),
    ),
    electronApp,
    electronWindow,
    desktopIpc,
  };
};

const configureWith = (services: ReturnType<typeof makeServices>) =>
  Effect.gen(function* () {
    const deepLink = yield* DesktopDeepLink.DesktopDeepLink;
    yield* Effect.scoped(deepLink.configure);
  }).pipe(
    Effect.provide(services.layer),
    Effect.provideService(ElectronApp.ElectronApp, services.electronApp),
    Effect.provideService(ElectronWindow.ElectronWindow, services.electronWindow),
    Effect.provideService(DesktopIpc.DesktopIpc, services.desktopIpc),
  );

const subscribeAs = (harness: TestHarness, fake: FakeSender) =>
  Effect.gen(function* () {
    const handler = harness.ipcHandlers.get(DEEP_LINK_SUBSCRIBE_CHANNEL);
    assert.isDefined(handler);
    return yield* handler!(undefined, { sender: fake.sender });
  });

// The OS listeners hand delivery to a fiber via runPromise; drain the
// immediate queue twice so that fiber has finished before asserting.
const settleDelivery = Effect.promise(
  () =>
    new Promise<void>((resolve) => {
      setImmediate(() => {
        setImmediate(() => resolve());
      });
    }),
);

describe("DesktopDeepLink", () => {
  it.effect("registers the OS listeners and the subscribe handler", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      yield* configureWith(makeServices(harness));

      assert.deepEqual([...harness.listeners.keys()], ["open-url", "second-instance"]);
      assert.deepEqual([...harness.ipcHandlers.keys()], [DEEP_LINK_SUBSCRIBE_CHANNEL]);
    });
  });

  it.effect("pushes a valid open-url link to the subscribed renderer", () => {
    const harness = makeHarness();
    const renderer = makeSender(7);

    return Effect.gen(function* () {
      yield* configureWith(makeServices(harness));

      assert.isNull(yield* subscribeAs(harness, renderer));

      const openUrl = harness.listeners.get("open-url");
      assert.isDefined(openUrl);
      const preventDefault = vi.fn();
      openUrl!({ preventDefault }, `t3code://app/${ENVIRONMENT_ID}/${THREAD_ID}`);
      yield* settleDelivery;

      assert.equal(preventDefault.mock.calls.length, 1);
      assert.deepEqual(harness.revealed, [harness.window]);
      assert.deepEqual(renderer.send.mock.calls, [[DEEP_LINK_CHANNEL, PAYLOAD]]);
    });
  });

  it.effect("leaves OAuth callback URLs untouched", () => {
    const harness = makeHarness();
    const renderer = makeSender(7);

    return Effect.gen(function* () {
      yield* configureWith(makeServices(harness));
      yield* subscribeAs(harness, renderer);

      const openUrl = harness.listeners.get("open-url");
      assert.isDefined(openUrl);
      const preventDefault = vi.fn();
      openUrl!({ preventDefault }, "t3code://app/oauth/callback?code=abc123");
      openUrl!({ preventDefault }, "https://clerk.t3.codes/v1/oauth_callback?code=abc123");
      yield* settleDelivery;

      assert.equal(preventDefault.mock.calls.length, 0);
      assert.deepEqual(harness.revealed, []);
      assert.equal(renderer.send.mock.calls.length, 0);
    });
  });

  it.effect("delivers a thread link found in second-instance argv", () => {
    const harness = makeHarness();
    const renderer = makeSender(7);

    return Effect.gen(function* () {
      yield* configureWith(makeServices(harness));
      yield* subscribeAs(harness, renderer);

      const secondInstance = harness.listeners.get("second-instance");
      assert.isDefined(secondInstance);
      secondInstance!(
        {},
        ["/usr/bin/t3code", "--allow", `t3code://app/${ENVIRONMENT_ID}/${THREAD_ID}`],
        "/tmp",
      );
      yield* settleDelivery;

      assert.deepEqual(renderer.send.mock.calls, [[DEEP_LINK_CHANNEL, PAYLOAD]]);
    });
  });

  it.effect(
    "buffers while only unsubscribed windows exist and hands the link to the first subscriber",
    () => {
      const harness = makeHarness();
      // The splash window's webContents never subscribes, so it must never
      // receive a push and must not swallow the link.
      const splash = makeSender(3);
      const renderer = makeSender(7);

      return Effect.gen(function* () {
        yield* configureWith(makeServices(harness));

        const openUrl = harness.listeners.get("open-url");
        assert.isDefined(openUrl);
        openUrl!({ preventDefault: vi.fn() }, `t3code://app/${ENVIRONMENT_ID}/${THREAD_ID}`);
        yield* settleDelivery;

        assert.equal(splash.send.mock.calls.length, 0);
        assert.equal(renderer.send.mock.calls.length, 0);
        assert.deepEqual(harness.revealed, []);

        // The subscriber pulls the buffered link exactly once.
        assert.deepEqual(yield* subscribeAs(harness, renderer), PAYLOAD);
        assert.isNull(yield* subscribeAs(harness, renderer));
      });
    },
  );

  it.effect("keeps only the latest link while buffering", () => {
    const harness = makeHarness();
    const renderer = makeSender(7);

    return Effect.gen(function* () {
      yield* configureWith(makeServices(harness));

      const openUrl = harness.listeners.get("open-url");
      assert.isDefined(openUrl);
      openUrl!({ preventDefault: vi.fn() }, `t3code://app/${ENVIRONMENT_ID}/${THREAD_ID}`);
      openUrl!({ preventDefault: vi.fn() }, `t3code://app/${ENVIRONMENT_ID}/${OTHER_THREAD_ID}`);
      yield* settleDelivery;

      assert.deepEqual(yield* subscribeAs(harness, renderer), {
        environmentId: ENVIRONMENT_ID,
        threadId: OTHER_THREAD_ID,
      });
    });
  });

  it.effect("drops destroyed subscribers and buffers for the next one", () => {
    const harness = makeHarness();
    const first = makeSender(7);
    const second = makeSender(9);

    return Effect.gen(function* () {
      yield* configureWith(makeServices(harness));
      yield* subscribeAs(harness, first);
      first.destroy();

      const openUrl = harness.listeners.get("open-url");
      assert.isDefined(openUrl);
      openUrl!({ preventDefault: vi.fn() }, `t3code://app/${ENVIRONMENT_ID}/${THREAD_ID}`);
      yield* settleDelivery;

      assert.equal(first.send.mock.calls.length, 0);
      assert.deepEqual(yield* subscribeAs(harness, second), PAYLOAD);
    });
  });

  it.effect("re-buffers when the subscriber dies between selection and send", () => {
    const harness = makeHarness();
    const dying = makeSender(7);
    const next = makeSender(9);

    return Effect.gen(function* () {
      yield* configureWith(makeServices(harness));
      yield* subscribeAs(harness, dying);
      // Alive when picked from the registry, destroyed by send time.
      dying.isDestroyed.mockReturnValueOnce(false).mockReturnValue(true);

      const openUrl = harness.listeners.get("open-url");
      assert.isDefined(openUrl);
      openUrl!({ preventDefault: vi.fn() }, `t3code://app/${ENVIRONMENT_ID}/${THREAD_ID}`);
      yield* settleDelivery;

      assert.equal(dying.send.mock.calls.length, 0);
      assert.deepEqual(yield* subscribeAs(harness, next), PAYLOAD);
    });
  });

  it.effect("drains URLs stashed by the early capture, latest first", () => {
    const harness = makeHarness();
    const renderer = makeSender(7);
    const removeListener = vi.fn();
    let captured: ((event: unknown, url: string) => void) | null = null;
    const source = {
      on: (_event: "open-url", listener: (event: unknown, url: string) => void) => {
        captured = listener;
      },
      removeListener,
    };

    return Effect.gen(function* () {
      DesktopDeepLink.captureEarlyOpenUrls(source);
      assert.isNotNull(captured);
      captured!({}, `t3code://app/${ENVIRONMENT_ID}/${THREAD_ID}`);
      captured!({}, `t3code://app/${ENVIRONMENT_ID}/${OTHER_THREAD_ID}`);
      captured!({}, "t3code://app/oauth/callback?code=abc123");

      yield* configureWith(makeServices(harness));

      assert.equal(removeListener.mock.calls.length, 1);
      assert.deepEqual(yield* subscribeAs(harness, renderer), {
        environmentId: ENVIRONMENT_ID,
        threadId: OTHER_THREAD_ID,
      });
    });
  });
});
