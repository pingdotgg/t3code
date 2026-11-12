import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as TestClock from "effect/testing/TestClock";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

import {
  baselineFor,
  layerCeilingsAt,
  layerCeilingsFromStore,
  layerCeilingsMemory,
  NadirCeilings,
  nadirRequestBody,
  pickModel,
  rememberChoice,
  routedSelection,
} from "./NadirRouting.ts";

const menu = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];
const context = { baseline: "claude-opus-4-6", current: "claude-opus-4-6", menu };
const routed = (model: string, extra: Record<string, unknown> = {}) => ({
  selected_model: model,
  coverage_held: false,
  input_truncated: false,
  policy: { advised_model: model, suppressed: false },
  ...extra,
});

describe("pickModel", () => {
  it("takes Nadir's qualified pick from the menu", () => {
    expect(pickModel(routed("claude-haiku-4-5"), context)).toBe("claude-haiku-4-5");
  });

  it.each([
    ["no answer", null],
    ["a model outside the menu", routed("gpt-5.5")],
    [
      "a suppressed saving",
      routed("claude-haiku-4-5", {
        policy: { advised_model: "claude-haiku-4-5", suppressed: true },
      }),
    ],
    [
      "advice that disagrees with the pick",
      routed("claude-haiku-4-5", {
        policy: { advised_model: "claude-sonnet-4-6", suppressed: false },
      }),
    ],
    ["a truncated prompt", routed("claude-haiku-4-5", { input_truncated: true })],
    ["held coverage", routed("claude-haiku-4-5", { coverage_held: true })],
    [
      "a warm cache worth keeping",
      routed("claude-haiku-4-5", { cache_advice: { decision: "stay_warm" } }),
    ],
  ])("keeps the user's pick on %s", (_label, answer) => {
    expect(pickModel(answer, context)).toBe("claude-opus-4-6");
  });

  it("keeps a cheaper model that already holds the cache when Nadir picks it again", () => {
    const answer = routed("claude-haiku-4-5", {
      policy: { advised_model: "claude-haiku-4-5", suppressed: true },
    });
    expect(pickModel(answer, { ...context, current: "claude-haiku-4-5" })).toBe("claude-haiku-4-5");
  });

  it("follows an organization's governance model when the menu has it", () => {
    expect(pickModel({ governance_model: "claude-sonnet-4-6" }, context)).toBe("claude-sonnet-4-6");
    expect(pickModel({ governance_model: "gpt-5.5" }, context)).toBe("claude-opus-4-6");
  });
});

describe("baselineFor", () => {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const opus: ModelSelection = { instanceId, model: "claude-opus-4-6", options: [] };
  const haiku: ModelSelection = { instanceId, model: "claude-haiku-4-5" };

  it.effect("keeps the user's pick as the ceiling after Nadir routes down", () =>
    Effect.gen(function* () {
      const ceilings = yield* NadirCeilings;
      yield* rememberChoice(ceilings, "thread-1", opus, haiku);
      // The picker now shows Haiku; sending again must not make Haiku the ceiling.
      expect(yield* baselineFor(ceilings, "thread-1", haiku)).toEqual(opus);
      // Kept only while the thread runs below its ceiling.
      yield* rememberChoice(ceilings, "thread-1", opus, opus);
      expect(Option.isNone(yield* ceilings.get("thread-1"))).toBe(true);
    }).pipe(Effect.provide(layerCeilingsMemory)),
  );

  it.effect("puts back the record a refused send replaced, unless a later turn saved one", () =>
    Effect.gen(function* () {
      const ceilings = yield* NadirCeilings;
      const sonnet: ModelSelection = { instanceId, model: "claude-sonnet-4-6" };
      yield* rememberChoice(ceilings, "thread-1", opus, haiku);
      // Routing back to the ceiling clears the record, then the server refuses the send.
      const backToOpus = { threadId: "thread-1", baseline: opus, chosen: opus };
      yield* ceilings.decide({ ...backToOpus, commandId: "send-1" });
      expect(Option.isNone(yield* ceilings.get("thread-1"))).toBe(true);
      yield* ceilings.undo("send-1");
      expect(yield* ceilings.get("thread-1")).toEqual(
        Option.some({ baseline: opus, chosen: haiku }),
      );
      // A retry of the refused command asks Nadir again.
      expect(ceilings.decided("send-1")).toBeUndefined();
      yield* ceilings.decide({ ...backToOpus, commandId: "send-2" });
      yield* rememberChoice(ceilings, "thread-1", opus, sonnet);
      yield* ceilings.undo("send-2");
      expect(yield* ceilings.get("thread-1")).toEqual(
        Option.some({ baseline: opus, chosen: sonnet }),
      );
    }).pipe(Effect.provide(layerCeilingsMemory)),
  );

  it.effect("keeps the ceiling across a server restart", () =>
    Effect.gen(function* () {
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      yield* Effect.gen(function* () {
        yield* rememberChoice(yield* NadirCeilings, "thread-1", opus, haiku);
      }).pipe(Effect.provide(layerCeilingsAt(directory)));
      // A fresh store on the same directory is what the next server process opens.
      const restarted = yield* Effect.gen(function* () {
        return yield* baselineFor(yield* NadirCeilings, "thread-1", haiku);
      }).pipe(Effect.provide(layerCeilingsAt(directory)));
      expect(restarted).toEqual(opus);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the ceiling in memory when the disk cannot save it", () => {
    let failedSaves = 0;
    const layerFailingSaves = Layer.effect(
      KeyValueStore.KeyValueStore,
      Effect.gen(function* () {
        const memory = yield* KeyValueStore.KeyValueStore;
        return KeyValueStore.make({
          get: memory.get,
          getUint8Array: memory.getUint8Array,
          remove: memory.remove,
          clear: memory.clear,
          size: memory.size,
          keys: memory.keys,
          set: (key) =>
            Effect.sync(() => (failedSaves += 1)).pipe(
              Effect.andThen(
                Effect.fail(
                  new KeyValueStore.KeyValueStoreError({ method: "set", key, message: "full" }),
                ),
              ),
            ),
        });
      }),
    ).pipe(Layer.provide(KeyValueStore.layerMemory));
    return Effect.gen(function* () {
      const ceilings = yield* NadirCeilings;
      yield* rememberChoice(ceilings, "thread-1", opus, haiku);
      expect(failedSaves).toBe(1);
      expect(yield* baselineFor(ceilings, "thread-1", haiku)).toEqual(opus);
    }).pipe(Effect.provide(layerCeilingsFromStore.pipe(Layer.provide(layerFailingSaves))));
  });

  it.effect("runs one routing turn at a time for each thread", () =>
    Effect.gen(function* () {
      const ceilings = yield* NadirCeilings;
      const order: string[] = [];
      const first = yield* ceilings
        .lock("thread-1")
        .withPermits(1)(
          Effect.sync(() => order.push("first started")).pipe(
            Effect.andThen(Effect.sleep("1 second")),
            Effect.andThen(Effect.sync(() => order.push("first finished"))),
          ),
        )
        .pipe(Effect.forkChild);
      const second = yield* ceilings
        .lock("thread-1")
        .withPermits(1)(Effect.sync(() => order.push("second")))
        .pipe(Effect.forkChild);
      const other = yield* ceilings
        .lock("thread-2")
        .withPermits(1)(Effect.sync(() => order.push("other thread")))
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      yield* Fiber.join(other);
      expect(order).toEqual(["first started", "other thread", "first finished", "second"]);
    }).pipe(Effect.provide(layerCeilingsMemory)),
  );

  it.effect("treats a model the user picks by hand as the new ceiling", () =>
    Effect.gen(function* () {
      const ceilings = yield* NadirCeilings;
      yield* rememberChoice(ceilings, "thread-1", opus, haiku);
      const sonnet: ModelSelection = { instanceId, model: "claude-sonnet-4-6" };
      expect(yield* baselineFor(ceilings, "thread-1", sonnet)).toBe(sonnet);
      expect(yield* baselineFor(ceilings, "thread-2", haiku)).toBe(haiku);
      // Changing only the effort of the model Nadir chose is a pick too.
      const haikuHigh: ModelSelection = { ...haiku, options: [{ id: "effort", value: "high" }] };
      expect(yield* baselineFor(ceilings, "thread-1", haikuHigh)).toBe(haikuHigh);
    }).pipe(Effect.provide(layerCeilingsMemory)),
  );
});

describe("routedSelection", () => {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const model = (slug: string, efforts: string[], defaultEffort: string, fast = false) =>
    ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: efforts.map((id) => ({ id, label: id, isDefault: id === defaultEffort })),
          },
          ...(fast ? [{ id: "fastMode", label: "Fast", type: "boolean" as const }] : []),
        ],
      },
    }) satisfies ServerProviderModel;
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "0.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-06T00:00:00.000Z",
    models: [
      model("opus", ["low", "medium", "high", "max"], "medium", true),
      model("sonnet", ["medium", "high", "max"], "high"),
      model("haiku", ["low", "medium", "high"], "medium"),
    ],
    slashCommands: [],
    skills: [],
  };

  it.each([
    [
      "the effort the picker showed, not the routed model's default",
      undefined,
      "sonnet",
      [{ id: "effort", value: "medium" }],
    ],
    [
      "a stated effort, dropping options the routed model lacks",
      [
        { id: "effort", value: "max" },
        { id: "fastMode", value: true },
      ],
      "sonnet",
      [{ id: "effort", value: "max" }],
    ],
    [
      "the routed model's default when it lacks the level",
      [{ id: "effort", value: "max" }],
      "haiku",
      [{ id: "effort", value: "medium" }],
    ],
  ])("keeps %s", (_label, options, target, expected) => {
    const baseline: ModelSelection = { instanceId, model: "opus", ...(options ? { options } : {}) };
    expect(routedSelection(baseline, target, provider)).toEqual({
      instanceId,
      model: target,
      options: expected,
    });
  });
});

describe("nadirRequestBody", () => {
  it("never lets Nadir route above the user's pick and prices the warm cache", () => {
    const body = nadirRequestBody({
      text: "Rename foo to bar in format.ts",
      baseline: "claude-opus-4-6",
      menu,
      driver: "claudeAgent",
      threadId: "thread-1",
      cache: { model: "claude-opus-4-6", contextTokens: 120_000 },
    });
    expect(body).toMatchObject({
      requested_model: "claude-opus-4-6",
      menu,
      policy: { allow_route_up: false },
      agent_session: { client: "claude-code", session_id: "thread-1" },
      cache: { model: "claude-opus-4-6", current_input_tokens: 120_000 },
    });
  });
});
