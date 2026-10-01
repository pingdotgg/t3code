import type { EnvironmentId, ExtensionApiSubscribeInput } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resumableApiFrames } from "./installedApiFrames";

const mocks = vi.hoisted(() => ({
  payloads: [] as unknown[],
  seam: { connectionId: "conn-live" as string | undefined, connecting: false },
  session: [] as unknown[],
}));

vi.mock("@t3tools/client-runtime/state/extensions", () => ({
  environmentExtensionApiStream: vi.fn(),
  // One transport session per call to `makePayload`, as the real
  // session-following stream opens them; `Option.none()` marks a suspension.
  environmentResumableExtensionApiStream: (_env: string, makePayload: () => unknown) =>
    Stream.suspend(() => {
      mocks.payloads.push(makePayload());
      return Stream.fromIterable(mocks.session);
    }),
}));

// A registered seam stamps client-routed calls with its id; a connecting one
// holds them until it registers (here, until the caller gives up).
vi.mock("./clientProviderConnection", () => ({
  currentClientConnectionId: () => mocks.seam.connectionId,
  withClientConnectionIdFrames: async function* (
    _env: string,
    signal: AbortSignal,
    open: (id: string | undefined) => AsyncIterable<unknown>,
  ) {
    if (mocks.seam.connecting) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      signal.throwIfAborted();
    }
    yield* open(mocks.seam.connectionId);
  },
}));

vi.mock("../rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/unstable/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});

vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const Layer = await import("effect/Layer");
  return { connectionAtomRuntime: Atom.runtime(Layer.empty) };
});

const ENV = "env-a" as EnvironmentId;
const payload = {
  installationId: "t3.terminal",
  expectedContentHash: "hash-a",
  request: { id: "t3.terminal/output-events", name: "subscribe", input: { terminalId: "a" } },
} as unknown as ExtensionApiSubscribeInput;

beforeEach(() => {
  mocks.payloads.length = 0;
  mocks.seam.connectionId = "conn-live";
  mocks.seam.connecting = false;
  mocks.session = [Option.some({ value: { kind: "snapshot" } })];
});

describe("resumableApiFrames", () => {
  it("opens the server-only stream without the client connection hint", async () => {
    const frames = [];
    for await (const frame of resumableApiFrames(ENV, payload, new AbortController().signal))
      frames.push(frame);

    expect(frames).toEqual([{ value: { kind: "snapshot" } }]);
    expect(mocks.payloads).toEqual([payload]);
  });

  it("reports each suspension between the frames around it", async () => {
    mocks.session = [
      Option.some({ value: "before", cursor: undefined }),
      Option.none(),
      Option.some({ value: "after", cursor: "c1" }),
    ];
    const seen: unknown[] = [];
    for await (const frame of resumableApiFrames(ENV, payload, new AbortController().signal, () =>
      seen.push("suspended"),
    ))
      seen.push(frame);

    expect(seen).toEqual([{ value: "before" }, "suspended", { value: "after", cursor: "c1" }]);
  });

  it("opens while the client-provider seam is still connecting", async () => {
    mocks.seam.connecting = true;
    mocks.seam.connectionId = undefined;
    const controller = new AbortController();
    const iterator = resumableApiFrames(ENV, payload, controller.signal)[Symbol.asyncIterator]();
    const first = iterator.next().then(
      (result) => result,
      () => null,
    );
    // Let the open run through the connection lookup and a frame arrive.
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    const opened = [...mocks.payloads];
    controller.abort();
    await first;

    expect(opened).toEqual([payload]);
  });
});
