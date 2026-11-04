import { assert, describe, it } from "@effect/vitest";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { createContributionStatusEnvironmentAtoms } from "@t3tools/client-runtime/state/contribution-status";
import {
  type ContributionStatusEntry,
  type ContributionStatusSnapshot,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type ServerConfig,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/reactivity";

import { contributionStatusChips } from "./ThreadContributionStatus.logic";

const THREAD = ThreadId.make("thread-1");
const OTHER_THREAD = ThreadId.make("thread-2");

const entry = (
  items: ContributionStatusEntry["items"],
  options: { session?: string; instance?: string; threadId?: ThreadId } = {},
): ContributionStatusEntry => ({
  threadId: options.threadId ?? THREAD,
  source: {
    kind: "provider-session",
    providerSessionId: ProviderSessionId.make(options.session ?? "session-1"),
    providerInstanceId: ProviderInstanceId.make(options.instance ?? "pi"),
    driver: ProviderDriverKind.make("pi"),
  },
  items,
});

describe("contributionStatusChips", () => {
  it("attributes a plugin's chips to the plugin by name, keyed by its id", () => {
    const pluginEntry = (name: string): ContributionStatusEntry => ({
      threadId: THREAD,
      source: { kind: "plugin", pluginId: "acme.ci", name },
      items: [{ key: "ci", text: "passing", tone: "success" }],
    });
    const [chip] = contributionStatusChips([pluginEntry("CI watcher")]);
    assert.deepStrictEqual(chip, {
      id: JSON.stringify([JSON.stringify(["plugin", "acme.ci"]), "ci"]),
      text: "passing",
      tone: "success",
      tooltip: null,
      origin: "From the CI watcher plugin.",
    });
    // A renamed plugin keeps its chip identity.
    assert.strictEqual(contributionStatusChips([pluginEntry("Renamed")])[0]?.id, chip?.id);
  });

  it("keeps the server's order and keys each chip by source plus item key", () => {
    const chips = contributionStatusChips([
      entry([
        { key: "mode", text: "● plan" },
        { key: "tokens", text: "12k" },
      ]),
      entry([{ key: "mode", text: "● plan" }], { session: "session-2", instance: "pi_work" }),
    ]);
    assert.deepStrictEqual(
      chips.map((chip) => chip.text),
      ["● plan", "12k", "● plan"],
    );
    // The same item key from another source is a different chip.
    assert.strictEqual(new Set(chips.map((chip) => chip.id)).size, 3);

    // A new provider session taking over with identical text still re-keys the chip.
    const [before] = contributionStatusChips([entry([{ key: "mode", text: "● plan" }])]);
    const [after] = contributionStatusChips([
      entry([{ key: "mode", text: "● plan" }], { session: "session-3" }),
    ]);
    assert.notStrictEqual(before!.id, after!.id);
  });

  it("defaults the tone, ignores empty tooltips, and names the producing instance", () => {
    const [plain, styled] = contributionStatusChips([
      entry([
        { key: "a", text: "idle", tooltip: "" },
        { key: "b", text: "failing", tone: "error", tooltip: "2 checks failed" },
      ]),
    ]);
    assert.deepStrictEqual([plain!.tone, plain!.tooltip], ["neutral", null]);
    assert.deepStrictEqual([styled!.tone, styled!.tooltip], ["error", "2 checks failed"]);
    assert.strictEqual(plain!.origin, "From a Pi extension. It can lag a session change.");

    const [custom] = contributionStatusChips([
      entry([{ key: "a", text: "x" }], { instance: "pi_work" }),
    ]);
    assert.strictEqual(custom!.origin, "From a Pi Work extension. It can lag a session change.");
  });

  it("renders no chips for no entries", () => {
    assert.deepStrictEqual(contributionStatusChips([]), []);
  });
});

const config = (contributionStatus: boolean) =>
  ({
    environment: {
      serverVersion: "0.0.1",
      capabilities: contributionStatus ? { contributionStatus: true } : {},
    },
  }) as ServerConfig;

/** Environments whose servers push status frames, read through the real client selector. */
const makeHarness = Effect.fn("makeHarness")(function* () {
  const makeServer = Effect.fn("makeServer")(function* (id: string, supported: boolean) {
    const frames = yield* Queue.unbounded<ContributionStatusSnapshot>();
    let subscriptions = 0;
    return {
      environmentId: EnvironmentId.make(id),
      config: Atom.make(config(supported)),
      subscriptions: () => subscriptions,
      push: (frame: ContributionStatusSnapshot) => Queue.offer(frames, frame),
      frames: Stream.suspend(() => {
        subscriptions += 1;
        return Stream.fromQueue(frames);
      }),
    };
  });
  const servers = [
    yield* makeServer("env-a", true),
    yield* makeServer("env-b", true),
    yield* makeServer("env-old", false),
  ] as const;
  const byId = new Map(servers.map((server) => [server.environmentId, server]));
  // Each environment's subscription reads its own server's frames.
  const registryService = {
    followStream: (environmentId: EnvironmentId) => byId.get(environmentId)!.frames,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registryService),
  );
  const atoms = createContributionStatusEnvironmentAtoms(runtime, {
    configValueAtom: (environmentId) => byId.get(environmentId)!.config,
  });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  const chipTexts = (environmentId: EnvironmentId, threadId = THREAD) =>
    contributionStatusChips(registry.get(atoms.threadStatus(environmentId, threadId))).map(
      (chip) => chip.text,
    );
  /** Waits until the header's chips match: the client-side receipt for a frame. */
  const waitForChips = (environmentId: EnvironmentId, expected: ReadonlyArray<string>) =>
    AtomRegistry.toStream(registry, atoms.threadStatus(environmentId, THREAD)).pipe(
      Stream.map((entries) => contributionStatusChips(entries).map((chip) => chip.text)),
      Stream.filter((actual) => actual.join("\n") === expected.join("\n")),
      Stream.runHead,
    );
  const mount = (environmentId: EnvironmentId, threadId = THREAD) =>
    Effect.acquireRelease(
      Effect.sync(() => registry.mount(atoms.threadStatus(environmentId, threadId))),
      (unmount) => Effect.sync(unmount),
    );
  return { servers, chipTexts, waitForChips, mount };
});

describe("thread status chips from the client selector", () => {
  it.effect("shows each environment's own statuses for the same thread id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { servers, chipTexts, waitForChips, mount } = yield* makeHarness();
        const [a, b] = servers;
        yield* mount(a.environmentId);
        yield* mount(b.environmentId);
        yield* mount(a.environmentId, OTHER_THREAD);

        yield* a.push({
          entries: [
            entry([{ key: "mode", text: "● plan" }]),
            entry([{ key: "mode", text: "● other" }], { threadId: OTHER_THREAD }),
          ],
        });
        yield* b.push({ entries: [entry([{ key: "mode", text: "● build" }])] });
        yield* waitForChips(a.environmentId, ["● plan"]);
        yield* waitForChips(b.environmentId, ["● build"]);
        assert.deepStrictEqual(chipTexts(a.environmentId, OTHER_THREAD), ["● other"]);
      }),
    ),
  );

  it.effect("replaces and clears chips with each frame", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { servers, waitForChips, mount } = yield* makeHarness();
        const [a] = servers;
        yield* mount(a.environmentId);

        yield* a.push({ entries: [entry([{ key: "mode", text: "● startup" }])] });
        yield* waitForChips(a.environmentId, ["● startup"]);
        yield* a.push({
          entries: [
            entry([
              { key: "mode", text: "● resume" },
              { key: "tokens", text: "12k" },
            ]),
          ],
        });
        yield* waitForChips(a.environmentId, ["● resume", "12k"]);
        yield* a.push({ entries: [] });
        yield* waitForChips(a.environmentId, []);
      }),
    ),
  );

  it.effect("shows nothing and never subscribes when the server lacks the capability", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { servers, chipTexts, waitForChips, mount } = yield* makeHarness();
        const [current, , old] = servers;
        yield* mount(old.environmentId);
        yield* mount(current.environmentId);

        yield* old.push({ entries: [entry([{ key: "mode", text: "● stale" }])] });
        // Once a supported environment has delivered, any subscription would have started.
        yield* current.push({ entries: [entry([{ key: "mode", text: "● plan" }])] });
        yield* waitForChips(current.environmentId, ["● plan"]);
        assert.strictEqual(old.subscriptions(), 0);
        assert.deepStrictEqual(chipTexts(old.environmentId), []);
      }),
    ),
  );
});
