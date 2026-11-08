import type { Contract } from "@prisma/orm-postgres/contract/types";
import type { SqlStorage } from "@prisma/orm-postgres/family-contract/types";
import type {
  AggregateBuilder,
  AggregateResult,
  AggregateSpec,
  Collection,
  CollectionTypeState,
  DefaultCollectionTypeState,
  DefaultModelRow,
  GroupedCollection,
  RelatedModelName,
  RelationNames,
  RelationsOf,
} from "@prisma/orm-postgres/orm-client";
import type { PostgresClient } from "@prisma/orm-postgres/runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { type ClientError, wrapPrismaError } from "./Errors.ts";

type AnyContract = Contract<SqlStorage>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type InitialState<Ns extends string> = Omit<DefaultCollectionTypeState, "nsId"> & {
  readonly nsId: Ns;
};
type WithState<S extends CollectionTypeState, Patch> = Omit<S, keyof Patch> & Patch;
type Args<F> = F extends {
  (...args: infer A): unknown;
  (...args: infer B): unknown;
  (...args: infer C): unknown;
  (...args: infer D): unknown;
}
  ? A | B | C | D
  : never;
type Native<
  C extends AnyContract,
  M extends string,
  Row,
  S extends CollectionTypeState,
> = Collection<C, M, Row, S>;
type NativeRow<T> = T extends { readonly _row?: infer Row } ? Row : never;
type Root<
  C extends AnyContract,
  Ns extends string,
  M extends string,
> = Ns extends keyof PostgresClient<C>["orm"]
  ? M extends keyof PostgresClient<C>["orm"][Ns]
    ? PostgresClient<C>["orm"][Ns][M]
    : never
  : never;

type RootRow<C extends AnyContract, Ns extends string, M extends string> = [
  Root<C, Ns, M>,
] extends [never]
  ? DefaultModelRow<C, M, Ns>
  : NativeRow<Root<C, Ns, M>>;

export type WhereFilter<C extends AnyContract, M extends string, Ns extends string> = Args<
  Native<C, M, DefaultModelRow<C, M, Ns>, InitialState<Ns>>["where"]
>[0];

/** Buffer a query with `yield*`, or consume its rows incrementally through `stream`. */
export interface QueryResult<Row, E, R> extends Effect.Effect<Row[], E, R> {
  readonly stream: Stream.Stream<Row, E, R>;
}

type Relation<
  C extends AnyContract,
  Ns extends string,
  M extends string,
  Rel extends string,
> = Rel extends keyof RelationsOf<C, M, Ns> ? RelationsOf<C, M, Ns>[Rel] : never;
type TargetNamespace<C extends AnyContract, Rel, Ns extends string> = Rel extends {
  readonly to: { readonly namespace: infer Target extends string };
}
  ? {
      [K in keyof C["domain"]["namespaces"] & string]: Target extends K ? K : never;
    }[keyof C["domain"]["namespaces"] & string]
  : Ns;
type RelatedRow<
  C extends AnyContract,
  Ns extends string,
  M extends string,
  Rel extends string,
> = RootRow<
  C,
  TargetNamespace<C, Relation<C, Ns, M, Rel>, Ns>,
  RelatedModelName<C, M, Rel, Ns> & string
>;
type IncludeOwner<
  C extends AnyContract,
  Ns extends string,
  M extends string,
  Rel extends string,
  S extends CollectionTypeState,
> = Rel extends RelationNames<C, M, Ns> ? M : S["variantName"] & string;
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type Cardinality<Rel> = Rel extends { readonly cardinality: infer Card } ? Card : "1:N";
type RelationValue<Rel, Row, Refined extends boolean = false> =
  Cardinality<Rel> extends "1:1" | "N:1"
    ? Refined extends true
      ? Row | null
      : Rel extends { readonly nullable: false }
        ? Row
        : Row | null
    : Row[];
type Terminal =
  | "all"
  | "first"
  | "aggregate"
  | "groupBy"
  | "create"
  | "createAll"
  | "createAndCount"
  | "upsert"
  | "update"
  | "updateAll"
  | "updateAndCount"
  | "delete"
  | "deleteAll"
  | "deleteAndCount";
type Refinement<
  C extends AnyContract,
  Ns extends string,
  M extends string,
  Rel extends string,
> = Omit<
  Native<
    C,
    RelatedModelName<C, M, Rel, Ns> & string,
    RelatedRow<C, Ns, M, Rel>,
    InitialState<TargetNamespace<C, Relation<C, Ns, M, Rel>, Ns>>
  >,
  | Terminal
  | (Cardinality<Relation<C, Ns, M, Rel>> extends "1:1" | "N:1"
      ?
          | "combine"
          | (string extends keyof AggregateBuilder<C, M, Ns>
              ? never
              : keyof AggregateBuilder<C, M, Ns>)
      : never)
>;
type RefinedValue<Rel, T> = T extends {
  readonly kind: "includeScalar" | "includeCombine";
}
  ? T[Extract<keyof T, symbol>]
  : RelationValue<Rel, NativeRow<T>, true>;
type RefinementResult =
  | { readonly _row?: unknown }
  | { readonly kind: "includeScalar" | "includeCombine" };
type Model<
  C extends AnyContract,
  Ns extends string,
  M extends string,
> = Ns extends keyof C["domain"]["namespaces"]
  ? M extends keyof C["domain"]["namespaces"][Ns]["models"]
    ? C["domain"]["namespaces"][Ns]["models"][M]
    : never
  : never;
type VariantRow<C extends AnyContract, Ns extends string, M extends string, V extends string> =
  Model<C, Ns, M> extends {
    readonly discriminator: { readonly field: infer Field extends string };
    readonly variants: infer Variants;
  }
    ? V extends keyof Variants
      ? Variants[V] extends { readonly value: infer Value }
        ? Simplify<
            Omit<DefaultModelRow<C, M, Ns>, Field> &
              DefaultModelRow<C, V, Ns> & { [K in Field]: Value }
          >
        : never
      : never
    : never;

/** Prisma's fluent collection, with native parameter types and Effect terminals. */
export interface EffectCollection<
  C extends AnyContract,
  Ns extends string,
  M extends string,
  Row,
  S extends CollectionTypeState = InitialState<Ns>,
  E = never,
  R = never,
> {
  where(
    ...args: Args<Native<C, M, Row, S>["where"]>
  ): EffectCollection<C, Ns, M, Row, WithState<S, { readonly hasWhere: true }>, E, R>;
  variant<V extends Parameters<Native<C, M, Row, S>["variant"]>[0]>(
    name: V,
  ): EffectCollection<
    C,
    Ns,
    M,
    VariantRow<C, Ns, M, V>,
    WithState<S, { readonly hasWhere: true; readonly variantName: V }>,
    E,
    R
  >;
  include<Rel extends Parameters<Native<C, M, Row, S>["include"]>[0]>(
    relation: Rel,
  ): EffectCollection<
    C,
    Ns,
    M,
    Simplify<
      Row & {
        [K in Rel]: RelationValue<
          Relation<C, Ns, IncludeOwner<C, Ns, M, K, S>, K>,
          RelatedRow<C, Ns, IncludeOwner<C, Ns, M, K, S>, K>
        >;
      }
    >,
    S,
    E,
    R
  >;
  include<
    Rel extends Parameters<Native<C, M, Row, S>["include"]>[0],
    Refined extends (Cardinality<Relation<C, Ns, IncludeOwner<C, Ns, M, Rel, S>, Rel>> extends
      | "1:1"
      | "N:1"
      ? { readonly _row?: unknown }
      : RefinementResult),
  >(
    relation: Rel,
    refine: (collection: Refinement<C, Ns, IncludeOwner<C, Ns, M, Rel, S>, Rel>) => Refined,
  ): EffectCollection<
    C,
    Ns,
    M,
    Simplify<
      Row & {
        [K in Rel]: RefinedValue<Relation<C, Ns, IncludeOwner<C, Ns, M, K, S>, K>, Refined>;
      }
    >,
    S,
    E,
    R
  >;
  select<
    const Fields extends readonly [
      keyof DefaultModelRow<C, M, Ns> & string,
      ...(keyof DefaultModelRow<C, M, Ns> & string)[],
    ],
  >(
    ...fields: Fields
  ): EffectCollection<
    C,
    Ns,
    M,
    Simplify<
      Pick<DefaultModelRow<C, M, Ns>, Fields[number]> & Omit<Row, KeysOfUnion<RootRow<C, Ns, M>>>
    >,
    S,
    E,
    R
  >;
  orderBy(
    ...args: Parameters<Native<C, M, Row, S>["orderBy"]>
  ): EffectCollection<C, Ns, M, Row, WithState<S, { readonly hasOrderBy: true }>, E, R>;
  cursor(
    ...args: Parameters<Native<C, M, Row, S>["cursor"]>
  ): EffectCollection<C, Ns, M, Row, S, E, R>;
  distinct(
    ...fields: Parameters<Native<C, M, Row, S>["distinct"]>
  ): EffectCollection<C, Ns, M, Row, S, E, R>;
  distinctOn(
    ...fields: Parameters<Native<C, M, Row, S>["distinctOn"]>
  ): EffectCollection<C, Ns, M, Row, S, E, R>;
  limit(n: number): EffectCollection<C, Ns, M, Row, S, E, R>;
  offset(n: number): EffectCollection<C, Ns, M, Row, S, E, R>;
  groupBy<
    const Fields extends readonly [
      keyof DefaultModelRow<C, M, Ns> & string,
      ...(keyof DefaultModelRow<C, M, Ns> & string)[],
    ],
  >(
    ...fields: Fields
  ): EffectGroupedCollection<C, Ns, M, Fields, false, E, R>;
  all(...args: Parameters<Native<C, M, Row, S>["all"]>): QueryResult<Row, ClientError | E, R>;
  first(
    ...args: Args<Native<C, M, Row, S>["first"]>
  ): Effect.Effect<Row | null, ClientError | E, R>;
  aggregate<Spec extends AggregateSpec>(
    fn: (aggregate: AggregateBuilder<C, M, Ns>) => Spec,
    ...configure: Parameters<Native<C, M, Row, S>["aggregate"]> extends [unknown, ...infer Rest]
      ? Rest
      : never
  ): Effect.Effect<AggregateResult<Spec>, ClientError | E, R>;
  create(...args: Args<Native<C, M, Row, S>["create"]>): Effect.Effect<Row, ClientError | E, R>;
  createAll(
    ...args: Parameters<Native<C, M, Row, S>["createAll"]>
  ): QueryResult<Row, ClientError | E, R>;
  createAndCount(
    ...args: Parameters<Native<C, M, Row, S>["createAndCount"]>
  ): Effect.Effect<number, ClientError | E, R>;
  upsert(
    ...args: Parameters<Native<C, M, Row, S>["upsert"]>
  ): Effect.Effect<Row, ClientError | E, R>;
  update(
    ...args: Parameters<Native<C, M, Row, S>["update"]>
  ): Effect.Effect<Row | null, ClientError | E, R>;
  updateAll(
    ...args: Parameters<Native<C, M, Row, S>["updateAll"]>
  ): QueryResult<Row, ClientError | E, R>;
  updateAndCount(
    ...args: Parameters<Native<C, M, Row, S>["updateAndCount"]>
  ): Effect.Effect<number, ClientError | E, R>;
  delete(
    this: S["hasWhere"] extends true ? EffectCollection<C, Ns, M, Row, S, E, R> : never,
    ...args: Parameters<Native<C, M, Row, S>["delete"]>
  ): Effect.Effect<Row | null, ClientError | E, R>;
  deleteAll(
    this: S["hasWhere"] extends true ? EffectCollection<C, Ns, M, Row, S, E, R> : never,
    ...args: Parameters<Native<C, M, Row, S>["deleteAll"]>
  ): QueryResult<Row, ClientError | E, R>;
  deleteAndCount(
    this: S["hasWhere"] extends true ? EffectCollection<C, Ns, M, Row, S, E, R> : never,
    ...args: Parameters<Native<C, M, Row, S>["deleteAndCount"]>
  ): Effect.Effect<number, ClientError | E, R>;
}

/** Grouped aggregates retain their selected keys and ordering requirements. */
export interface EffectGroupedCollection<
  C extends AnyContract,
  Ns extends string,
  M extends string,
  Fields extends readonly (keyof DefaultModelRow<C, M, Ns> & string)[],
  Ordered extends boolean = false,
  E = never,
  R = never,
> {
  having(
    ...args: Parameters<GroupedCollection<C, M, Fields, Ns, Ordered>["having"]>
  ): EffectGroupedCollection<C, Ns, M, Fields, Ordered, E, R>;
  orderBy(
    ...args: Parameters<GroupedCollection<C, M, Fields, Ns, Ordered>["orderBy"]>
  ): EffectGroupedCollection<C, Ns, M, Fields, true, E, R>;
  limit(
    n: Ordered extends true ? number : never,
  ): EffectGroupedCollection<C, Ns, M, Fields, Ordered, E, R>;
  offset(
    n: Ordered extends true ? number : never,
  ): EffectGroupedCollection<C, Ns, M, Fields, Ordered, E, R>;
  aggregate<Spec extends AggregateSpec>(
    fn: (aggregate: AggregateBuilder<C, M, Ns>) => Spec,
    ...configure: Parameters<GroupedCollection<C, M, Fields, Ns, Ordered>["aggregate"]> extends [
      unknown,
      ...infer Rest,
    ]
      ? Rest
      : never
  ): Effect.Effect<
    Array<Simplify<Pick<DefaultModelRow<C, M, Ns>, Fields[number]> & AggregateResult<Spec>>>,
    ClientError | E,
    R
  >;
}

export type EffectOrm<C extends AnyContract, E = never, R = never> = {
  readonly [Ns in keyof C["domain"]["namespaces"] & string]: {
    readonly [M in keyof C["domain"]["namespaces"][Ns]["models"] & string]: EffectCollection<
      C,
      Ns,
      M,
      NativeRow<Root<C, Ns, M>>,
      InitialState<Ns>,
      E,
      R
    >;
  };
};

const TERMINALS = new Set([
  "all",
  "first",
  "aggregate",
  "create",
  "createAll",
  "createAndCount",
  "upsert",
  "update",
  "updateAll",
  "updateAndCount",
  "delete",
  "deleteAll",
  "deleteAndCount",
]);
const STREAMING_TERMINALS = new Set(["all", "createAll", "updateAll", "deleteAll"]);
interface PathStep {
  readonly prop: string;
  readonly args?: readonly unknown[];
}
const replayPath = (base: unknown, path: readonly PathStep[]): unknown =>
  path.reduce<any>(
    (current, step) =>
      step.args === undefined ? current[step.prop] : current[step.prop](...step.args),
    base,
  );

const node = (root: Effect.Effect<unknown, any, any>, path: readonly PathStep[]): any =>
  new Proxy(function () {}, {
    get: (_target, prop) => {
      if (typeof prop !== "string" || prop === "then") return undefined;
      return node(root, [...path, { prop }]);
    },
    apply: (_target, _this, args: unknown[]) => {
      const last = path[path.length - 1]!;
      const called = [...path.slice(0, -1), { prop: last.prop, args }];
      if (!TERMINALS.has(last.prop)) return node(root, called);
      const effect = Effect.flatMap(root, (base) =>
        Effect.tryPromise({
          try: () => Promise.resolve(replayPath(base, called)),
          catch: wrapPrismaError,
        }),
      );
      if (!STREAMING_TERMINALS.has(last.prop)) return effect;
      return Object.assign(effect, {
        stream: Stream.unwrap(
          Effect.flatMap(root, (base) =>
            Effect.try({
              try: () =>
                Stream.fromAsyncIterable(
                  replayPath(base, called) as AsyncIterable<unknown>,
                  wrapPrismaError,
                ),
              catch: wrapPrismaError,
            }),
          ),
        ),
      });
    },
  });

/** Replays native builders per execution; refinement callbacks stay native and pure. */
export const makeOrmProxy = <C extends AnyContract, E, R>(
  root: Effect.Effect<unknown, E, R>,
): EffectOrm<C, E, R> => node(root, []);
