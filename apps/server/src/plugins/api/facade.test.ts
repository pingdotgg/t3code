import { assert, it } from "@effect/vitest";
import { PluginId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makePluginActivation } from "../PluginApi.ts";
import { makeFacadeContext, pluginCodeScope } from "./facade.ts";

class CallFailedError extends Schema.TaggedError<CallFailedError>()("CallFailedError", {}) {}

// Two macrotask turns: Node reports a rejection nobody observed after the first.
const afterNodeReportsRejections = Effect.promise(async () => {
  for (let turn = 0; turn < 2; turn++) {
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- Node emits unhandledRejection only between macrotasks; no promise can mark that point.
    await new Promise((resolve) => setImmediate(resolve));
  }
});

it.effect("keeps a failed call the plugin never awaits from stopping the server", () =>
  Effect.gen(function* () {
    const activation = makePluginActivation();
    const facade = makeFacadeContext({
      pluginId: PluginId.make("unawaited"),
      activation,
      context: yield* Effect.context<never>(),
    });
    const unobserved: Array<unknown> = [];
    const onUnhandled = (reason: unknown) => unobserved.push(reason);
    process.on("unhandledRejection", onUnhandled);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => process.off("unhandledRejection", onUnhandled)),
    );

    void facade.call(Effect.fail(new CallFailedError()));
    // A stream it reads, such as `api.settings.changes()`, fails like a call.
    const pull = () =>
      facade.iterate(Stream.fail(new CallFailedError()))[Symbol.asyncIterator]().next();
    void pull();
    const pulled = yield* Effect.promise(() =>
      pull().then(
        () => undefined,
        (error: { readonly code: string }) => error.code,
      ),
    );
    assert.strictEqual(pulled, "CallFailedError");
    activation.controller.abort();
    activation.ended.abort();
    // A timer such as `setInterval(() => void api.storage.set(...))` outliving the plugin.
    void facade.call(Effect.void);
    yield* afterNodeReportsRejections;
    assert.deepStrictEqual(unobserved, []);

    const awaited = yield* Effect.promise(() =>
      facade.call(Effect.void).then(
        () => undefined,
        (error: { readonly code: string }) => error.code,
      ),
    );
    assert.strictEqual(awaited, "PluginDeactivated");
  }).pipe(Effect.scoped),
);

// A failure there would be tied to the plugin, and the guard would not stop the server for it.
it.effect("runs T3's side of a stream the plugin reads outside the plugin's scope", () =>
  Effect.gen(function* () {
    const pluginId = PluginId.make("reading");
    const facade = makeFacadeContext({
      pluginId,
      activation: makePluginActivation(),
      context: yield* Effect.context<never>(),
    });
    const scopes = facade.iterate(Stream.fromEffect(Effect.sync(() => pluginCodeScope.getStore())));
    // As a plugin's `for await` over `api.settings.changes()`.
    const seen = yield* Effect.promise(() =>
      pluginCodeScope.run(pluginId, async () => {
        const values: Array<string | undefined> = [];
        for await (const value of scopes) values.push(value);
        return values;
      }),
    );
    assert.deepStrictEqual(seen, [undefined]);
  }),
);
