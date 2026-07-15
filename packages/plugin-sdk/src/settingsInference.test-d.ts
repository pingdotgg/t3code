/**
 * COMPILE-TIME tests for settings type inference.
 *
 * These probes `orDie` the capability and read errors to isolate INFERENCE. That
 * mirrors the real contract: `register` returns `Effect<_, Error>` while capability
 * acquisition fails with `PluginCapabilityUnavailable` (a tagged interface, not an
 * Error subclass), so every plugin already discharges capability errors — the
 * hello-board fixture does exactly this via its own toPluginError.
 *
 * These exist because the "hands the plugin typed config" claim was FALSE and no
 * runtime test could have caught it: the code ran fine, every field was just
 * `unknown` at the type level. A reviewer's compiler probe found it. These
 * assertions fail the build if inference regresses.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { definePlugin, type PluginRegistration } from "./index.ts";

declare const expectString: (value: string) => void;
declare const expectBoolean: (value: boolean) => void;
declare const registration: PluginRegistration;

// POSITIVE: fields must infer their declared types, not `unknown`.
definePlugin({
  settings: {
    schema: Schema.Struct({
      baseUrl: Schema.String,
      shout: Schema.Boolean,
    }),
  },
  register: (hostApi) =>
    Effect.gen(function* () {
      const settings = yield* hostApi.settings.pipe(Effect.orDie);
      const config = yield* settings.get.pipe(Effect.orDie);
      // @ts-expect-no-error — this is the whole point of declaring a schema.
      expectString(config.baseUrl);
      expectBoolean(config.shout);
      return registration;
    }),
});

// NEGATIVE: a field that is not a string must not satisfy `expectString`.
definePlugin({
  settings: { schema: Schema.Struct({ shout: Schema.Boolean }) },
  register: (hostApi) =>
    Effect.gen(function* () {
      const settings = yield* hostApi.settings.pipe(Effect.orDie);
      const config = yield* settings.get.pipe(Effect.orDie);
      // @ts-expect-error boolean is not assignable to string
      expectString(config.shout);
      return registration;
    }),
});

// NEGATIVE: a schema whose DECODING needs services must be rejected at the
// declaration site. The host decodes stored values with no plugin context, so this
// has to be a compile error rather than a runtime failure.
declare const serviceBoundSchema: Schema.Codec<
  { readonly a: string },
  { readonly a: string },
  { readonly _: unique symbol },
  never
>;
definePlugin({
  // @ts-expect-error decoding services must be `never`
  settings: { schema: serviceBoundSchema },
  register: () => registration,
});

// A plugin declaring no settings still compiles.
definePlugin({ register: () => registration });
