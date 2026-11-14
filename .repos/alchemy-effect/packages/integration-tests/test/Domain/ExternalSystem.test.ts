import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

class RefundDeclined extends Domain.Rejection("RefundDeclined", { reason: Schema.String }) {}
class CardFrozen extends Domain.Rejection("CardFrozen") {}

class Payments extends Domain.ExternalSystem("Payments", {
  refund: {
    args: { settlementId: Schema.String, amount: Schema.Int },
    success: { refundId: Schema.String },
    error: RefundDeclined,
  },
  ping: {},
}) {}

/** An adapter whose answers the test picks, to break each side of the schema. */
const adapter = (answer: (args: { settlementId: string; amount: number }) => unknown) => {
  const seen: Array<unknown> = [];
  const layer = Payments.toLayer(
    Effect.succeed({
      refund: (args) => {
        seen.push(args);
        return answer(args) as never;
      },
      ping: () => Effect.succeed("pong" as unknown as void),
    }),
  );
  return { seen, layer };
};

const refund = (args: unknown) =>
  Effect.gen(function* () {
    const payments = yield* Payments;
    return yield* payments.refund(args as never);
  });

const defectOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

describe("Domain ExternalSystem", { tags: ["unit", "local"] }, () => {
  it.effect("passes valid arguments to the adapter and returns its answer", () =>
    Effect.gen(function* () {
      const { seen, layer } = adapter(({ settlementId }) =>
        Effect.succeed({ refundId: `re_${settlementId}` }),
      );
      const result = yield* refund({ settlementId: "st_1", amount: 500 }).pipe(
        Effect.provide(layer),
      );
      expect(result).toEqual({ refundId: "re_st_1" });
      expect(seen).toEqual([{ settlementId: "st_1", amount: 500 }]);
    }),
  );

  it.effect("keeps a declared error a typed failure", () =>
    Effect.gen(function* () {
      const { layer } = adapter(() => Effect.fail(new RefundDeclined({ reason: "card-closed" })));
      const error = yield* refund({ settlementId: "st_1", amount: 500 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      expect(error).toEqual(new RefundDeclined({ reason: "card-closed" }));
    }),
  );

  it.effect("arguments the schema rejects die before the adapter runs", () =>
    Effect.gen(function* () {
      const { seen, layer } = adapter(() => Effect.succeed({ refundId: "re_1" }));
      const exit = yield* refund({ settlementId: "st_1", amount: 1.5 }).pipe(
        Effect.exit,
        Effect.provide(layer),
      );
      const defect = defectOf(exit);
      expect(defect).toMatchObject({
        _tag: "ExternalSystemSchemaError",
        system: "Payments",
        op: "refund",
        part: "args",
      });
      expect(String((defect as Error).message)).toMatch(
        /^Payments\.refund was called with arguments its schema rejects\n.*amount/s,
      );
      expect(seen).toEqual([]);
    }),
  );

  it.effect("a value the success schema rejects dies", () =>
    Effect.gen(function* () {
      const { layer } = adapter(() => Effect.succeed({ refundId: 42 }));
      const exit = yield* refund({ settlementId: "st_1", amount: 500 }).pipe(
        Effect.exit,
        Effect.provide(layer),
      );
      expect(defectOf(exit)).toMatchObject({ system: "Payments", op: "refund", part: "success" });
      expect(String((defectOf(exit) as Error).message)).toMatch(
        /^Payments\.refund returned a value its success schema rejects\n.*refundId/s,
      );
    }),
  );

  it.effect("an error the operation does not declare dies", () =>
    Effect.gen(function* () {
      const { layer } = adapter(() => Effect.fail(new CardFrozen()));
      const exit = yield* refund({ settlementId: "st_1", amount: 500 }).pipe(
        Effect.exit,
        Effect.provide(layer),
      );
      expect(defectOf(exit)).toMatchObject({ system: "Payments", op: "refund", part: "error" });
      expect(String((defectOf(exit) as Error).message)).toMatch(
        /^Payments\.refund failed with an error its error schema rejects\n/,
      );
    }),
  );

  it.effect("keeps every error of a declared list a typed failure", () =>
    Effect.gen(function* () {
      class Cards extends Domain.ExternalSystem("Cards", {
        charge: { args: { amount: Schema.Int }, error: [RefundDeclined, CardFrozen] },
      }) {}
      const layer = Cards.toLayer(
        Effect.succeed({
          charge: ({ amount }) =>
            amount > 100
              ? Effect.fail(new CardFrozen())
              : Effect.fail(new RefundDeclined({ reason: "low" })),
        }),
      );
      const charge = (amount: number) =>
        Effect.gen(function* () {
          const cards = yield* Cards;
          return yield* cards.charge({ amount });
        }).pipe(Effect.flip, Effect.provide(layer));
      expect(yield* charge(500)).toEqual(new CardFrozen());
      expect(yield* charge(5)).toEqual(new RefundDeclined({ reason: "low" }));
    }),
  );

  it.effect("drops fields the success schema does not declare", () =>
    Effect.gen(function* () {
      const { layer } = adapter(() => Effect.succeed({ refundId: "re_1", raw: { vendor: "x" } }));
      const result = yield* refund({ settlementId: "st_1", amount: 500 }).pipe(
        Effect.provide(layer),
      );
      expect(result).toEqual({ refundId: "re_1" });
    }),
  );

  it.effect("leaves the value of an operation without a success schema alone", () =>
    Effect.gen(function* () {
      const { layer } = adapter(() => Effect.succeed({ refundId: "re_1" }));
      const result = yield* Effect.gen(function* () {
        const payments = yield* Payments;
        return yield* payments.ping();
      }).pipe(Effect.provide(layer));
      expect(result).toBe("pong");
    }),
  );

  it.effect("validate: false skips every check", () =>
    Effect.gen(function* () {
      const layer = Payments.toLayer(
        Effect.succeed({
          refund: () => Effect.succeed({ refundId: 42 } as never),
          ping: () => Effect.void,
        }),
        { validate: false },
      );
      const result = yield* refund({ settlementId: "st_1", amount: 1.5 }).pipe(
        Effect.provide(layer),
      );
      expect(result).toEqual({ refundId: 42 });
    }),
  );

  it.effect("refuses an operation named after a static of the class", () =>
    Effect.gen(function* () {
      class Clash extends Domain.ExternalSystem("Clash", {
        // @ts-expect-error toLayer is the class's own static
        toLayer: {},
      }) {}
      const exit = yield* Effect.exit(
        Layer.build(Clash.toLayer(Effect.succeed({} as never))).pipe(Effect.scoped),
      );
      expect(defectOf(exit)).toMatchObject({
        _tag: "DefinitionError",
        reason: { _tag: "ReservedOperation", system: "Clash", operation: "toLayer" },
      });
    }),
  );
});
