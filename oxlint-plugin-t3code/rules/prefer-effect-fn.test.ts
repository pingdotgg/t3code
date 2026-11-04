import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/prefer-effect-fn");

describe("t3code/prefer-effect-fn", () => {
  rule.valid(
    "allows inline programs and layer construction",
    `
    import * as Effect from "effect/Effect";
    import * as Layer from "effect/Layer";
    export const program = Effect.gen(function* () { yield* Effect.void; });
    export const layer = Layer.effectDiscard(Effect.gen(function* () { yield* Effect.void; }));
  `,
  );

  rule.valid(
    "allows named functions and deliberate untraced functions",
    `
    import * as Effect from "effect/Effect";
    export const read = Effect.fn("Files.read")(function* () { yield* Effect.void; });
    export const chunk = Effect.fnUntraced(function* () { yield* Effect.void; });
  `,
  );

  rule.valid(
    "allows inline combinator callbacks",
    `
    import * as Effect from "effect/Effect";
    export const program = Effect.void.pipe(Effect.flatMap(() => Effect.gen(function* () {
      yield* Effect.void;
    })));
  `,
  );

  rule.valid(
    "allows inline option and error callbacks",
    `
    import * as Effect from "effect/Effect";
    import * as Option from "effect/Option";
    export const program = Option.match(Option.none(), {
      onNone: () => Effect.gen(function* () { yield* Effect.void; }),
      onSome: () => Effect.void,
    });
    export const recovered = Effect.fail({ _tag: "Failed" }).pipe(Effect.catchTags({
      Failed: () => Effect.gen(function* () { yield* Effect.void; }),
    }));
  `,
  );

  rule.valid(
    "allows reference default-value callbacks",
    `
    import * as Context from "effect/Context";
    import * as Effect from "effect/Effect";
    export const Default = Context.Reference("Default", {
      defaultValue: () => Effect.gen(function* () { yield* Effect.void; }),
    });
  `,
  );

  for (const name of ["onSome", "onNone", "onSuccess", "onFailure", "defaultValue"]) {
    rule.invalid(
      `reports service members named ${name}`,
      `
      import * as Effect from "effect/Effect";
      export const service = Service.of({
        ${name}: () => Effect.gen(function* () { yield* Effect.void; }),
      });
    `,
    );
  }

  rule.valid(
    "does not mistake other namespaces or shadowed locals for Effect",
    `
    import * as Effect from "effect/Effect";
    const Other = { gen: (body: () => unknown) => body() };
    export const other = () => Other.gen(function* () {});
    export function scoped(Effect: typeof Other) {
      return Effect.gen(function* () {});
    }
    export const effect = Effect.void;
  `,
  );

  rule.valid(
    "leaves functions with synchronous setup for manual review",
    `
    import * as Effect from "effect/Effect";
    export const read = () => {
      const state = new Map();
      return Effect.gen(function* () { yield* Effect.void; return state; });
    };
  `,
  );

  rule.invalid(
    "reports a named arrow wrapper",
    `
    import * as Effect from "effect/Effect";
    export const read = (path: string) => Effect.gen(function* () {
      yield* Effect.void;
      return path;
    });
  `,
    (output) => {
      assert.match(output, /Effect\.fn/);
      assert.match(output, /documented hot paths/);
    },
  );

  rule.invalid(
    "reports a block-bodied wrapper",
    `
    import * as Effect from "effect/Effect";
    export const read = () => { return Effect.gen(function* () { yield* Effect.void; }); };
  `,
  );

  rule.invalid(
    "reports a declaration with pipe transforms",
    `
    import * as Effect from "effect/Effect";
    export function read() {
      return Effect.gen(function* () { yield* Effect.void; }).pipe(Effect.asVoid);
    }
  `,
  );

  rule.invalid(
    "reports a function expression",
    `
    import * as Effect from "effect/Effect";
    export const read = function() { return Effect.gen(function* () { yield* Effect.void; }); };
  `,
  );

  rule.invalid(
    "reports service members",
    `
    import * as Effect from "effect/Effect";
    export const service = {
      read: () => Effect.gen(function* () { yield* Effect.void; }),
    };
  `,
  );

  rule.invalid(
    "reports class fields",
    `
    import * as Effect from "effect/Effect";
    export class Service {
      read = () => Effect.gen(function* () { yield* Effect.void; });
    }
  `,
  );

  rule.invalid(
    "recognizes namespace aliases",
    `
    import * as Eff from "effect/Effect";
    export const read = () => Eff.gen(function* () { yield* Eff.void; });
  `,
  );

  rule.invalid(
    "recognizes bare-package Effect imports",
    `
    import { Effect } from "effect";
    export const read = () => Effect.gen(function* () { yield* Effect.void; });
  `,
  );

  rule.invalid(
    "recognizes a direct gen import",
    `
    import { gen, void as noop } from "effect/Effect";
    export const read = () => gen(function* () { yield* noop; });
  `,
  );
  rule.invalid(
    "reports class methods",
    `
    import * as Effect from "effect/Effect";
    export class Service {
      read() { return Effect.gen(function* () { yield* Effect.void; }); }
    }
  `,
  );

  rule.valid(
    "allows getters that expose an effect value",
    `
    import * as Effect from "effect/Effect";
    export class Service {
      get read() { return Effect.gen(function* () { yield* Effect.void; }); }
    }
  `,
  );
});
