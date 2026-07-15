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
      // Plain typecheck: if inference regresses to `unknown`, these two lines error.
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

// NEGATIVE: service-bound schemas must be rejected at the DECLARATION site, because
// the host decodes stored values and re-encodes them on write with no plugin context.
//
// These MUST be real Schema.Structs whose FIELDS carry the service requirement. An
// earlier version declared bare `Schema.Codec`s, which a reviewer showed were vacuous:
// a Codec has no `.fields`, so `PluginDefinition<S extends Schema.Struct<...>>`
// rejected them for lacking Struct fields — they stayed red even with the `never`
// service constraints removed, proving nothing about the constraint they existed to
// guard.
declare const decodeBoundField: Schema.Codec<string, string, { readonly _: unique symbol }, never>;
declare const encodeBoundField: Schema.Codec<string, string, never, { readonly _: unique symbol }>;

definePlugin({
  // @ts-expect-error decoding services must be `never`
  settings: { schema: Schema.Struct({ a: decodeBoundField }) },
  register: () => registration,
});

definePlugin({
  // @ts-expect-error encoding services must be `never` (Schema.Decoder<T, RD> would
  // permit this: it expands to Codec<T, unknown, RD, unknown>)
  settings: { schema: Schema.Struct({ a: encodeBoundField }) },
  register: () => registration,
});

// A plugin declaring no settings still compiles.
definePlugin({ register: () => registration });
