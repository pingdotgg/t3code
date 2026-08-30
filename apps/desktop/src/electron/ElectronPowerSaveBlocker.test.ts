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
  it.effect("holds one prevent-app-suspension assertion idempotently", () =>
    Effect.gen(function* () {
      const { api, calls, started } = makeStubApi();
      const service = ElectronPowerSaveBlocker.make(api);

      yield* service.setKeepAwake(true);
      yield* service.setKeepAwake(true);

      assert.deepStrictEqual(calls, ["start:prevent-app-suspension:0"]);
      assert.strictEqual(started.size, 1);
    }),
  );

  it.effect("releases the held assertion idempotently", () =>
    Effect.gen(function* () {
      const { api, calls, started } = makeStubApi();
      const service = ElectronPowerSaveBlocker.make(api);

      yield* service.setKeepAwake(true);
      yield* service.setKeepAwake(false);
      yield* service.setKeepAwake(false);

      assert.deepStrictEqual(calls, ["start:prevent-app-suspension:0", "stop:0"]);
      assert.strictEqual(started.size, 0);
    }),
  );

  it.effect("reacquires an assertion Electron no longer reports as active", () =>
    Effect.gen(function* () {
      const { api, calls, started } = makeStubApi();
      const service = ElectronPowerSaveBlocker.make(api);

      yield* service.setKeepAwake(true);
      started.clear();
      yield* service.setKeepAwake(true);

      assert.deepStrictEqual(calls, [
        "start:prevent-app-suspension:0",
        "start:prevent-app-suspension:1",
      ]);
    }),
  );
});
