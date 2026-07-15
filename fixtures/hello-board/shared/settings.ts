/**
 * Settings schema shared by BOTH plugin entries.
 *
 * This module is the point of the fixture. The server entry declares it so the host
 * can validate writes; the web entry declares it so the host can render the form.
 * Because the two entries are bundled separately, each gets its own copy of the
 * schema object at runtime — harmless (both are constructed by the host's Schema
 * classes and every use is structural), but it does mean the host cannot verify they
 * match. Importing one source is what keeps them from drifting.
 *
 * Two constraints this file demonstrates, both of which the host enforces:
 *  - `import { Schema } from "effect"` — the bare specifier. `effect/Schema` is NOT
 *    in the browser import map, so a subpath import compiles but fails at runtime in
 *    the web bundle.
 *  - Only renderable field shapes: string-ish controls and boolean switches. A
 *    Number/Array/nested Struct is rejected at registration rather than rendered as
 *    a text box that can never be saved.
 */
import { Effect, Schema } from "effect";

export const HelloBoardSettings = Schema.Struct({
  greeting: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed("Hello")),
    Schema.annotateKey({
      title: "Greeting",
      description: "Prefix used when the plugin echoes a note back.",
      providerSettingsForm: { control: "text", placeholder: "Hello" },
    }),
  ),
  shout: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
    Schema.annotateKey({
      title: "Shout",
      description: "Uppercase the greeting.",
      providerSettingsForm: { control: "switch" },
    }),
  ),
});
