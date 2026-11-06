import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe } from "vitest";
import { make } from "../src/Vitest.ts";

const seen: Array<string> = [];

const { afterAll, test } = make({ providers: Layer.empty });

// Fails if the shared scope is already closed when the hook runs: a finalizer
// added to a closed scope runs immediately, before `finished` is set.
const assertScopeOpen = (name: string) =>
  Effect.gen(function* () {
    let finished = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (!finished) {
          throw new Error(`shared scope closed before afterAll "${name}" finished`);
        }
      }),
    );
    seen.push(name);
    finished = true;
  });

// Run under both `sequence.hooks: "stack"` (default) and `"list"`; see
// vitest.config.ts. The cleanup hook must follow both, whichever order applies.
afterAll(assertScopeOpen("first"));
afterAll(assertScopeOpen("second"));

describe("scoped", () => {
  afterAll(
    Effect.sync(() => {
      seen.push("scoped");
    }),
  );
  test(
    "runs",
    Effect.sync(() => undefined),
  );
});

describe("after scoped", () => {
  test(
    "a describe's afterAll runs when that describe finishes",
    Effect.sync(() => {
      if (seen.join(",") !== "scoped") {
        throw new Error(`expected only the scoped afterAll to have run, saw: ${seen.join(",")}`);
      }
    }),
  );
});
