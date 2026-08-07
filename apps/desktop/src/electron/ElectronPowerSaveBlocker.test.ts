import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ElectronPowerSaveBlocker from "./ElectronPowerSaveBlocker.ts";

function makeStubApi() {
  const calls: string[] = [];
  const started = new Set<number>();
  let nextId = 0;
  const api: ElectronPowerSaveBlocker.PowerSaveBlockerApi = {
    start: (type) => {
      const id = nextId++;
      started.add(id);
      calls.push(`start:${type}:${id}`);
      return id;
    },
    stop: (id) => {
      calls.push(`stop:${id}`);
      return started.delete(id);
    },
    isStarted: (id) => started.has(id),
  };
  return { api, calls, started };
}

describe("ElectronPowerSaveBlocker", () => {
  it.effect("starts a single prevent-app-suspension blocker and is idempotent", () =>
    Effect.gen(function* () {
      const { api, calls, started } = makeStubApi();
      const service = ElectronPowerSaveBlocker.make(api);

      assert.isTrue(yield* service.setKeepAwake(true));
      assert.isTrue(yield* service.setKeepAwake(true));

      assert.deepStrictEqual(calls, ["start:prevent-app-suspension:0"]);
      assert.strictEqual(started.size, 1);
    }),
  );

  it.effect("stops the held blocker and reports inactive", () =>
    Effect.gen(function* () {
      const { api, calls, started } = makeStubApi();
      const service = ElectronPowerSaveBlocker.make(api);

      yield* service.setKeepAwake(true);
      assert.isFalse(yield* service.setKeepAwake(false));

      assert.deepStrictEqual(calls, ["start:prevent-app-suspension:0", "stop:0"]);
      assert.strictEqual(started.size, 0);
    }),
  );

  it.effect("treats release without a held blocker as a no-op", () =>
    Effect.gen(function* () {
      const { api, calls } = makeStubApi();
      const service = ElectronPowerSaveBlocker.make(api);

      assert.isFalse(yield* service.setKeepAwake(false));
      assert.deepStrictEqual(calls, []);
    }),
  );

  it.effect("re-acquires a fresh blocker after a release", () =>
    Effect.gen(function* () {
      const { api, calls } = makeStubApi();
      const service = ElectronPowerSaveBlocker.make(api);

      yield* service.setKeepAwake(true);
      yield* service.setKeepAwake(false);
      yield* service.setKeepAwake(true);

      assert.deepStrictEqual(calls, [
        "start:prevent-app-suspension:0",
        "stop:0",
        "start:prevent-app-suspension:1",
      ]);
    }),
  );

  it.effect("restarts instead of trusting a blocker Electron no longer reports as started", () =>
    Effect.gen(function* () {
      const { api, calls, started } = makeStubApi();
      const service = ElectronPowerSaveBlocker.make(api);

      yield* service.setKeepAwake(true);
      started.clear();

      assert.isTrue(yield* service.setKeepAwake(true));
      assert.deepStrictEqual(calls, [
        "start:prevent-app-suspension:0",
        "start:prevent-app-suspension:1",
      ]);
    }),
  );
});
