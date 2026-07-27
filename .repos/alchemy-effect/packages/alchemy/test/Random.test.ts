import * as Provider from "@/Provider";
import { Random, RandomProvider } from "@/Random";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({
  providers: RandomProvider(),
  state: inMemoryState(),
});

describe("Alchemy.Random", () => {
  test.provider("list returns [] for the non-listable random secret", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Random("list-secret");
        }),
      );

      const provider = yield* Provider.findProvider(Random);
      expect(yield* provider.list()).toEqual([]);

      yield* stack.destroy();
    }),
  );
});
