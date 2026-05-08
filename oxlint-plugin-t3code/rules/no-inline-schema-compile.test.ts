import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-inline-schema-compile");

describe("t3code/no-inline-schema-compile", () => {
  rule.valid(
    "allows schema compilers hoisted to module scope",
    `
      import { Schema } from "effect";

      const User = Schema.Struct({ name: Schema.String });
      const decodeUser = Schema.decodeUnknownEffect(User);

      export const parseUser = (input: unknown) => decodeUser(input);
    `,
  );

  rule.valid(
    "allows factory helpers that return a precompiled decoder",
    `
      import { Schema } from "effect";

      export const makeParser = <A, I>(schema: Schema.Codec<A, I>) => {
        const decode = Schema.decodeUnknownEffect(schema);
        return (input: unknown) => decode(input);
      };
    `,
  );

  rule.valid(
    "allows schema construction helpers that use encode transformations",
    `
      import { Schema } from "effect";

      export const makePrettyJson = <S extends Schema.Top>(schema: S) =>
        Schema.fromJsonString(schema).pipe(
          Schema.encode({
            decode: Schema.String,
            encode: Schema.String,
          }),
        );
    `,
  );

  rule.valid(
    "allows dynamic schema parameters that cannot be hoisted to module scope",
    `
      import { Schema } from "effect";

      export const parseWith = <A, I>(schema: Schema.Codec<A, I>, input: unknown) =>
        Schema.decodeUnknownEffect(schema)(input);
    `,
  );

  rule.invalid(
    "reports schema compilers inside function bodies",
    `
      import { Schema } from "effect";

      const User = Schema.Struct({ name: Schema.String });

      export const parseUser = (input: unknown) => Schema.decodeUnknownEffect(User)(input);
    `,
    (output) => {
      assert.match(output, /Hoist Schema\.decodeUnknownEffect/);
    },
  );

  rule.invalid(
    "reports inline schema literals as high confidence findings",
    `
      import { Schema } from "effect";

      export const parseUser = (input: unknown) =>
        Schema.decodeUnknownEffect(Schema.Struct({ name: Schema.String }))(input);
    `,
    (output) => {
      assert.match(output, /inline schema literal and the compiled function/);
    },
  );
});
