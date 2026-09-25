// Run by `bun test ./<path>` from Bun.test.ts — the `.fixture.ts` suffix
// keeps alchemy-test from collecting it. Exercises `alchemy/Test/Bun`'s
// teardown guard: bun:test stops running later `afterAll` hooks once one
// throws, so the adapter must run its fallback cleanup (closing the shared
// scope and sidecar) itself before rethrowing — otherwise a failing
// teardown assertion leaks them for the rest of the process.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Test from "@/Test/Bun.ts";

const { test, beforeAll, afterAll } = Test.make({
  providers: Layer.empty as never,
});

// Attaches to the adapter's shared scope (provided to every hook/test by
// `Core.toEffect`), so this line printing proves the fallback cleanup ran.
beforeAll(
  Effect.addFinalizer(() =>
    Effect.sync(() => console.log("BUN_GUARD:shared-scope-finalizer-ran")),
  ),
);

afterAll(
  Effect.sync(() => {
    console.log("BUN_GUARD:user-afterAll-throws");
  }).pipe(Effect.andThen(Effect.fail(new Error("teardown-assertion-failed")))),
);

test("body", Effect.void);
