import { Action } from "@/Action.ts";
import type { Input } from "@/Input.ts";
import type * as Output from "@/Output.ts";
import type * as Brand from "effect/Brand";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";

// Branded primitives (effect/Brand or Schema.brand) must stay opaque
// Outputs. Before the `[A] extends [Primitive]` short-circuit in
// `ToOutput`, `string & Brand<..>` matched `Extract<A, object>` (the brand
// is an object-typed intersection member) and exploded into an ObjectExpr
// mapped over every String method.

type UserId = string & Brand.Brand<"UserId">;

const OrderId = S.String.pipe(S.brand("OrderId"));
type OrderId = typeof OrderId.Type;

type PortNum = number & Brand.Brand<"PortNum">;

// --- ToOutput keeps branded primitives as plain Output ---
type NotExploded<T> = "charAt" extends keyof T
  ? false
  : "toFixed" extends keyof T
    ? false
    : true;

declare const t1: NotExploded<Output.ToOutput<UserId, never>>;
declare const t2: NotExploded<Output.ToOutput<OrderId, never>>;
declare const t3: NotExploded<Output.ToOutput<PortNum, never>>;
const _t1: true = t1;
const _t2: true = t2;
const _t3: true = t3;

// branded primitive Output is assignable where the plain Output is expected
declare const brandedOut: Output.ToOutput<UserId, never>;
const _o1: Output.Output<UserId, never> = brandedOut;

// --- objects still upgrade to ObjectExpr, and their branded props stay opaque ---
type Attrs = { id: UserId; nested?: { orderId: OrderId } };
declare const attrs: Output.ToOutput<Attrs, never>;
const idOut = attrs.id;
declare const t4: NotExploded<typeof idOut>;
const _t4: true = t4;
const _o2: Output.Output<UserId, never> = idOut;

// arrays still upgrade to ArrayExpr
declare const arr: Output.ToOutput<UserId[], never>;
const first = arr[0];
declare const t5: NotExploded<typeof first>;
const _t5: true = t5;

// --- Input accepts branded values without expanding them ---
declare const uid: UserId;
declare const uidOut: Output.Output<UserId>;
const _i1: Input<UserId> = uid;
const _i2: Input<UserId> = uidOut;

// --- Action outputs carrying branded types stay opaque ---
const MintId = Action(
  "MintId",
  Effect.fn(function* (_input: { seed: string }) {
    return { userId: uid, plain: "x" as string };
  }),
);

const _program = Effect.gen(function* () {
  const minted = yield* MintId({ seed: "s" });
  const mintedId = minted.userId;
  const t6: NotExploded<typeof mintedId> = true;
  const _o3: Output.Output<UserId, never> = mintedId;
  return [t6, _o3] as const;
});
