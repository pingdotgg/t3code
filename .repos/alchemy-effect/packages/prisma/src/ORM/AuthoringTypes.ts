import type {
  ContractModelBuilder,
  ScalarFieldBuilder,
  field as nativeField,
} from "@prisma/orm-postgres/contract-builder";
import type { JsonValue } from "@prisma/orm-postgres/contract/types";
import type sqlPack from "@prisma/orm-postgres/family/pack";
import type postgresPack from "@prisma/orm-postgres/target/pack";

type FieldState = ScalarFieldBuilder["__state"];
type Set<S, K extends PropertyKey, V> = Omit<S, K> & { readonly [P in K]: V };
type Constraint<Name extends string | undefined> = { readonly name?: Name };

/** Retains default presence through native field chains; no runtime wrapper. */
export type Field<S extends FieldState> = {
  default<const D extends Parameters<ScalarFieldBuilder<S>["default"]>[0]>(
    value: D,
  ): Field<
    Set<
      S,
      "default",
      D extends { readonly kind: "function"; readonly expression: string }
        ? D
        : { readonly kind: "literal"; readonly value: JsonValue }
    >
  >;
  defaultSql<const E extends string>(
    expression: E,
  ): Field<Set<S, "default", { readonly kind: "function"; readonly expression: E }>>;
  optional(): Field<Set<S, "nullable", true>>;
  many(): Field<Set<S, "many", true>>;
  column<const N extends string>(name: N): Field<Set<S, "columnName", N>>;
  id<const N extends string | undefined = undefined>(
    options?: Constraint<N>,
  ): Field<Set<S, "id", Constraint<N>>>;
  unique<const N extends string | undefined = undefined>(
    options?: Constraint<N>,
  ): Field<Set<S, "unique", Constraint<N>>>;
  sql<const Spec extends Parameters<ScalarFieldBuilder<S>["sql"]>[0]>(
    spec: Spec,
  ): Field<
    (Spec extends { readonly column: infer N extends string } ? Set<S, "columnName", N> : S) &
      (Spec extends { readonly id: { readonly name: infer N extends string } }
        ? { readonly id: Constraint<N> }
        : {}) &
      (Spec extends {
        readonly unique: { readonly name: infer N extends string };
      }
        ? { readonly unique: Constraint<N> }
        : {})
  >;
  noCheck(...args: Parameters<ScalarFieldBuilder<S>["noCheck"]>): Field<S>;
} & ScalarFieldBuilder<S>;

type AnyModel = ContractModelBuilder<
  string | undefined,
  Record<string, ScalarFieldBuilder>,
  Record<string, never>
>;
type Attributes = Exclude<Parameters<AnyModel["attributes"]>[0], (...args: never[]) => unknown>;
type Sql = Exclude<Parameters<AnyModel["sql"]>[0], (...args: never[]) => unknown>;
type Relations = Parameters<AnyModel["relations"]>[0];
type IndexTypes = AnyModel["__indexTypes"];

type ModelBase = Pick<
  ContractModelBuilder<
    string | undefined,
    Record<string, ScalarFieldBuilder>,
    Relations,
    Attributes | undefined,
    Sql | undefined
  >,
  | "__name"
  | "__fields"
  | "__relations"
  | "__attributes"
  | "__sql"
  | "__indexTypes"
  | "__spaceId"
  | "stageOne"
>;
type Rebuild<B extends ModelBase> = ContractModelBuilder<
  B["__name"],
  B["__fields"],
  B["__relations"],
  B["__attributes"],
  B["__sql"],
  B["__indexTypes"],
  B["__spaceId"]
>;
export type Model<B extends ModelBase, Namespace extends string> = Omit<
  B,
  "sql" | "attributes" | "relations" | "stageOne"
> & {
  readonly stageOne: B["stageOne"] & { readonly namespace?: Namespace };
  relations<const R extends Relations>(
    relations: R,
  ): Model<
    ContractModelBuilder<
      B["__name"],
      B["__fields"],
      B["__relations"] & R,
      B["__attributes"],
      B["__sql"],
      B["__indexTypes"],
      B["__spaceId"]
    >,
    Namespace
  >;
  attributes<const A extends Attributes>(
    spec:
      | A
      | ((
          context: Parameters<
            Extract<Parameters<Rebuild<B>["attributes"]>[0], (...args: never[]) => unknown>
          >[0],
        ) => A),
  ): Model<
    ContractModelBuilder<
      B["__name"],
      B["__fields"],
      B["__relations"],
      A,
      B["__sql"],
      B["__indexTypes"],
      B["__spaceId"]
    >,
    Namespace
  >;
  sql<const S extends Sql>(
    spec:
      | S
      | ((
          context: Parameters<
            Extract<Parameters<Rebuild<B>["sql"]>[0], (...args: never[]) => unknown>
          >[0],
        ) => S),
  ): Model<
    ContractModelBuilder<
      B["__name"],
      B["__fields"],
      B["__relations"],
      B["__attributes"],
      S,
      B["__indexTypes"],
      B["__spaceId"]
    >,
    Namespace
  >;
};

export interface ModelHelper<I extends IndexTypes = IndexTypes> {
  <
    const Name extends string,
    F extends Record<string, ScalarFieldBuilder>,
    R extends Relations = Record<never, never>,
    const N extends string = "public",
  >(
    name: Name,
    input: {
      readonly fields: F;
      readonly relations?: R;
      readonly namespace?: N;
    },
  ): Model<ContractModelBuilder<Name, F, R, undefined, undefined, I>, N>;
  <
    F extends Record<string, ScalarFieldBuilder>,
    R extends Relations = Record<never, never>,
    const N extends string = "public",
  >(input: {
    readonly fields: F;
    readonly relations?: R;
    readonly namespace?: N;
  }): Model<ContractModelBuilder<undefined, F, R, undefined, undefined, I>, N>;
}

type WrapField<B> = B extends ScalarFieldBuilder<infer S> ? Field<S> : B;
type Descriptor = Parameters<typeof nativeField.column>[0];
export interface CoreFieldHelpers {
  column<const D extends Descriptor>(
    descriptor: D,
  ): WrapField<ReturnType<typeof nativeField.column<D>>>;
  namedType: typeof nativeField.namedType;
  generated<const D extends Descriptor>(
    spec: Parameters<typeof nativeField.generated<D>>[0],
  ): WrapField<ReturnType<typeof nativeField.generated<D>>>;
}
type Presets = typeof postgresPack.authoring.field & typeof sqlPack.authoring.field;
type Defaults<S extends FieldState, D> = S &
  (D extends { readonly output: { readonly default: infer Default } }
    ? { readonly default: Default }
    : {}) &
  (D extends { readonly output: { readonly executionDefaults: infer Defaults } }
    ? { readonly executionDefaults: Defaults }
    : {});
type FieldNamespace<H, D> = {
  readonly [K in keyof H]: H[K] extends (...args: infer Args) => ScalarFieldBuilder<infer S>
    ? (...args: Args) => Field<Defaults<S, K extends keyof D ? D[K] : {}>>
    : H[K] extends object
      ? FieldNamespace<H[K], K extends keyof D ? D[K] : {}>
      : H[K];
};
export type FieldHelpers<H> = Omit<FieldNamespace<H, Presets>, keyof CoreFieldHelpers> &
  CoreFieldHelpers;
export type Helpers<
  H extends {
    readonly field: object;
    readonly model: (...args: never[]) => ModelBase;
  },
> = {
  readonly [
    K in keyof H as string extends K ? never : K extends "field" | "model" ? never : K
  ]: H[K];
} & {
  readonly field: FieldHelpers<H["field"]>;
  readonly model: ModelHelper<ReturnType<H["model"]>["__indexTypes"]>;
};
