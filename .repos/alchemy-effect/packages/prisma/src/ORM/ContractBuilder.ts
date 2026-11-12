import type { QueryOperationTypes } from "@prisma/orm-postgres/adapter/operation-types";
import {
  defineContract as nativeDefineContract,
  field as nativeField,
  model as nativeModel,
} from "@prisma/orm-postgres/contract-builder";
import type { Contract, NamespaceId } from "@prisma/orm-postgres/contract/types";
import type {
  ContractWithTypeMaps,
  ExtractTypeMapsFromContract,
  SqlStorage,
  TypeMapsPhantomKey,
} from "@prisma/orm-postgres/family-contract/types";
import type { CodecTypes } from "@prisma/orm-postgres/target/codec-types";
import type { FieldHelpers, Helpers, ModelHelper } from "./AuthoringTypes.ts";
import type { PostgresAggregateTypes } from "./PostgresAggregateTypes.ts";

// Native authoring stays behind an opt-in module to preserve the optional peer.
export * from "@prisma/orm-postgres/contract-builder";
export type { DescriptorCodecInput } from "@prisma/orm-postgres/relational-core/ast";
export const field = nativeField as FieldHelpers<typeof nativeField>;
export const model = nativeModel as ModelHelper;

type NativeFactory = Parameters<typeof nativeDefineContract>[1];
type Authored = ReturnType<NativeFactory>;
type Types = NonNullable<Authored["types"]>;
type Models = NonNullable<Authored["models"]>;
type Enums = NonNullable<Authored["enums"]>;
type Extensions = Parameters<typeof nativeDefineContract>[0]["extensions"];
type Empty = Record<never, never>;
type IdentityNaming = {
  readonly naming?: {
    readonly tables?: "identity";
    readonly columns?: "identity";
  };
};
type ContractShape = Pick<Contract<SqlStorage>, "domain"> & {
  readonly storage: Pick<SqlStorage, "namespaces">;
};
type Known<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};
type State<F> = F extends { readonly __state: infer S } ? S : never;
type Fields<M> = M extends { readonly stageOne: { readonly fields: infer F } } ? F : never;
type Relations<M> = M extends {
  readonly stageOne: { readonly relations: infer R };
}
  ? R
  : never;
type Namespace<M> = M extends {
  readonly stageOne: { readonly namespace?: infer N extends string };
}
  ? N extends "unbound"
    ? "__unbound__"
    : N
  : "public";
type Namespaces<Ms extends Models> = Namespace<Ms[keyof Ms]>;
type ModelRef<R> = R extends { readonly modelName: infer M extends string }
  ? M
  : R extends { readonly resolve: () => infer M extends string }
    ? M
    : never;
type Tuple<T> = T extends readonly string[] ? T : T extends string ? readonly [T] : readonly [];
type InlineIds<M> = {
  [K in keyof Fields<M>]: State<Fields<M>[K]> extends { readonly id: object } ? K : never;
}[keyof Fields<M>] &
  string;
type PrimaryFields<M> = M extends {
  readonly __attributes: {
    readonly id: { readonly fields: infer F extends readonly string[] };
  };
}
  ? F
  : readonly [InlineIds<M>];
type NullableFields<M> = {
  [K in keyof Fields<M>]: State<Fields<M>[K]> extends {
    readonly nullable: true;
  }
    ? K
    : never;
}[keyof Fields<M>];
type IsNullable<M, F> = Extract<Tuple<F>[number], NullableFields<M>> extends never ? false : true;
type NativeModels<C extends ContractShape> = C["domain"]["namespaces"][string]["models"];
type Table<
  C extends ContractShape,
  M extends keyof NativeModels<C>,
> = NativeModels<C>[M]["storage"]["table"] & string;
type Column<
  C extends ContractShape,
  M extends keyof NativeModels<C>,
  F,
> = F extends keyof NativeModels<C>[M]["storage"]["fields"]
  ? NativeModels<C>[M]["storage"]["fields"][F] extends {
      readonly column: infer Col extends string;
    }
    ? Col
    : never
  : never;
type Columns<
  C extends ContractShape,
  M extends keyof NativeModels<C>,
  Fs extends readonly string[],
> = { readonly [K in keyof Fs]: Column<C, M, Fs[K]> };

type RelationType<C extends ContractShape, Ms extends Models, M extends keyof Ms, R> = R extends {
  readonly kind: infer Kind;
  readonly toModel: infer To;
}
  ? ModelRef<To> extends keyof Ms
    ? {
        readonly to: {
          readonly namespace: Namespace<Ms[ModelRef<To>]> & NamespaceId;
          readonly model: ModelRef<To>;
        };
      } & (R extends {
        readonly kind: "belongsTo";
        readonly from: infer From;
        readonly to: infer Target;
      }
        ? {
            readonly cardinality: "N:1";
            readonly nullable: IsNullable<Ms[M], From>;
            readonly on: {
              readonly localFields: Tuple<From>;
              readonly targetFields: Tuple<Target>;
            };
          }
        : R extends {
              readonly kind: "hasMany" | "hasOne";
              readonly by: infer By;
            }
          ? {
              readonly cardinality: Kind extends "hasOne" ? "1:1" : "1:N";
              readonly nullable: true;
              readonly on: {
                readonly localFields: PrimaryFields<Ms[M]>;
                readonly targetFields: Tuple<By>;
              };
            }
          : R extends {
                readonly kind: "manyToMany";
                readonly through: infer Through;
                readonly from: infer From;
                readonly to: infer Target;
              }
            ? ModelRef<Through> extends keyof Ms & keyof NativeModels<C>
              ? {
                  readonly cardinality: "N:M";
                  readonly on: {
                    readonly localFields: PrimaryFields<Ms[M]>;
                    readonly targetFields: PrimaryFields<Ms[ModelRef<To>]>;
                  };
                  readonly through: {
                    readonly namespaceId: Namespace<Ms[ModelRef<Through>]>;
                    readonly table: Table<C, ModelRef<Through>>;
                    readonly parentColumns: Columns<C, ModelRef<Through>, Tuple<From>>;
                    readonly childColumns: Columns<C, ModelRef<Through>, Tuple<Target>>;
                    readonly targetColumns: Columns<
                      C,
                      ModelRef<To> & keyof NativeModels<C>,
                      PrimaryFields<Ms[ModelRef<To>]>
                    >;
                  };
                }
              : never
            : never)
    : never
  : never;

type Unmany<T> = T extends readonly (infer A)[] ? A : T;
type FixFields<C extends ContractShape, Ms extends Models, Map> = Map extends {
  readonly public: infer ModelsMap;
}
  ? {
      readonly [Ns in Namespaces<Ms>]: {
        readonly [M in keyof ModelsMap & keyof Ms as Namespace<Ms[M]> extends Ns ? M : never]: {
          readonly [F in keyof ModelsMap[M]]: F extends keyof Fields<Ms[M]>
            ? true extends State<Fields<Ms[M]>[F]>["many"]
              ? ModelsMap[M][F]
              : M extends keyof NativeModels<C>
                ? Column<C, M, F> extends keyof NativeColumns<C, M>
                  ? NativeColumns<C, M>[Column<C, M, F>] extends {
                      readonly many: true;
                    }
                    ? Unmany<ModelsMap[M][F]>
                    : ModelsMap[M][F]
                  : ModelsMap[M][F]
                : ModelsMap[M][F]
            : ModelsMap[M][F];
        };
      };
    }
  : never;
type StorageFields<C extends ContractShape, Ms extends Models, Map> = {
  readonly [Ns in keyof Map]: {
    readonly [M in keyof Map[Ns] & keyof Ms & keyof NativeModels<C> as Table<C, M>]: {
      readonly [F in keyof Map[Ns][M] as Column<C, M, F>]: Map[Ns][M][F];
    };
  };
};
export interface AuthoringTypeMaps<
  Inputs,
  Outputs,
  StorageInputs,
  StorageOutputs,
  AdditionalCodecs,
> {
  readonly codecTypes: CodecTypes & AdditionalCodecs;
  readonly fieldInputTypes: Inputs;
  readonly fieldOutputTypes: Outputs;
  readonly storageColumnInputTypes: StorageInputs;
  readonly storageColumnTypes: StorageOutputs;
  readonly queryOperationTypes: QueryOperationTypes<CodecTypes>;
  readonly aggregateTypes: PostgresAggregateTypes;
}
type FixedMaps<
  C extends ContractShape,
  Ms extends Models,
  Maps = ExtractTypeMapsFromContract<C>,
> = Maps extends {
  readonly codecTypes: infer Codecs;
  readonly fieldInputTypes: infer Inputs;
  readonly fieldOutputTypes: infer Outputs;
}
  ? AuthoringTypeMaps<
      Materialize<FixFields<C, Ms, Inputs>>,
      Materialize<FixFields<C, Ms, Outputs>>,
      Materialize<StorageFields<C, Ms, FixFields<C, Ms, Inputs>>>,
      Materialize<StorageFields<C, Ms, FixFields<C, Ms, Outputs>>>,
      Omit<Known<Codecs>, keyof CodecTypes>
    >
  : never;
type FixedModels<C extends ContractShape, Ms extends Models, Ns extends string> = {
  readonly [M in keyof Ms & keyof NativeModels<C> as Namespace<Ms[M]> extends Ns ? M : never]: Omit<
    NativeModels<C>[M],
    "relations" | "storage"
  > & {
    readonly storage: NativeModels<C>[M]["storage"] & {
      readonly namespaceId: Namespace<Ms[M]>;
    };
    readonly relations: {
      readonly [R in keyof Relations<Ms[M]>]: RelationType<C, Ms, M, State<Relations<Ms[M]>[R]>>;
    };
  };
};
type InlineUniques<
  C extends ContractShape,
  Ms extends Models,
  M extends keyof Ms & keyof NativeModels<C>,
> = {
  [F in keyof Fields<Ms[M]> & string]: State<Fields<Ms[M]>[F]> extends {
    readonly unique: object;
  }
    ? { readonly columns: readonly [Column<C, M, F>] }
    : never;
}[keyof Fields<Ms[M]> & string];
type AttributeUniques<
  C extends ContractShape,
  Ms extends Models,
  M extends keyof Ms & keyof NativeModels<C>,
> = Ms[M] extends {
  readonly __attributes: { readonly uniques: readonly (infer U)[] };
}
  ? U extends { readonly fields: infer Fs extends readonly string[] }
    ? { readonly columns: Columns<C, M, Fs> }
    : never
  : never;
type NativeTables<C extends ContractShape> =
  C["storage"]["namespaces"]["public"]["entries"]["table"];
type NativeColumns<C extends ContractShape, M extends keyof NativeModels<C>> =
  Table<C, M> extends keyof NativeTables<C>
    ? NativeTables<C>[Table<C, M>] extends { readonly columns: infer Cols }
      ? Cols
      : never
    : never;
type FixColumn<Col, S> = Omit<Col, "many" | "default"> &
  (S extends { readonly many?: infer Many }
    ? true extends Many
      ? { readonly many: true }
      : Empty
    : Empty) &
  (S extends { readonly default: infer D } ? { readonly default: D } : Empty);
type FixedTable<
  C extends ContractShape,
  Ms extends Models,
  M extends keyof Ms & keyof NativeModels<C>,
> =
  Table<C, M> extends keyof NativeTables<C>
    ? Omit<NativeTables<C>[Table<C, M>], "columns" | "uniques"> & {
        readonly columns: {
          readonly [F in keyof Fields<Ms[M]> as Column<C, M, F>]: Column<
            C,
            M,
            F
          > extends keyof NativeColumns<C, M>
            ? FixColumn<NativeColumns<C, M>[Column<C, M, F>], State<Fields<Ms[M]>[F]>>
            : never;
        };
        readonly uniques: readonly (InlineUniques<C, Ms, M> | AttributeUniques<C, Ms, M>)[];
      }
    : never;
type FixStorage<C extends ContractShape, Ms extends Models> = Omit<C["storage"], "namespaces"> & {
  readonly namespaces: {
    readonly [Ns in Namespaces<Ms> | "public"]: {
      readonly id: Ns;
      readonly kind: string;
      readonly entries: {
        readonly table: {
          readonly [
            M in keyof Ms & keyof NativeModels<C> as Namespace<Ms[M]> extends Ns
              ? Table<C, M>
              : never
          ]: FixedTable<C, Ms, M>;
        };
      };
    };
  };
};

type PostgresCapabilities = {
  readonly postgres: {
    readonly distinctOn: true;
    readonly jsonAgg: true;
    readonly lateral: true;
    readonly limit: true;
    readonly orderBy: true;
    readonly returning: true;
  };
  readonly sql: {
    readonly checkConstraint: true;
    readonly defaultInInsert: true;
    readonly enums: true;
    readonly lateral: true;
    readonly returning: true;
    readonly scalarList: true;
  };
};
type ExecutionDefaults<C extends ContractShape, Ms extends Models> = {
  [M in keyof Ms & keyof NativeModels<C>]: {
    [F in keyof Fields<Ms[M]>]: State<Fields<Ms[M]>[F]> extends {
      readonly executionDefaults: infer D;
    }
      ? D & {
          readonly ref: {
            readonly namespace: Namespace<Ms[M]>;
            readonly table: Table<C, M>;
            readonly column: Column<C, M, F>;
          };
        }
      : never;
  }[keyof Fields<Ms[M]>];
}[keyof Ms & keyof NativeModels<C>];
type Depths = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8];
type Materialize<T, Depth extends number = 9> = Depth extends 0
  ? T
  : T extends
        | string
        | number
        | bigint
        | boolean
        | symbol
        | null
        | undefined
        | Date
        | Uint8Array
        | ((...args: never[]) => unknown)
    ? T
    : T extends object
      ? {
          [K in keyof T]: K extends TypeMapsPhantomKey ? T[K] : Materialize<T[K], Depths[Depth]>;
        }
      : T;
/** Native runtime contract with rc.11's erased authoring metadata restored. */
export type AuthoredContract<C extends ContractShape, Ms extends Models> = ContractWithTypeMaps<
  Omit<C, "domain" | "storage" | "capabilities" | "execution" | TypeMapsPhantomKey> & {
    readonly domain: Omit<C["domain"], "namespaces"> & {
      readonly namespaces: {
        readonly [Ns in Namespaces<Ms>]: {
          readonly models: FixedModels<C, Ms, Ns>;
        };
      };
    };
    readonly storage: FixStorage<C, Ms>;
    readonly capabilities: PostgresCapabilities;
  } & ([ExecutionDefaults<C, Ms>] extends [never]
      ? Empty
      : {
          readonly execution: {
            readonly executionHash: NonNullable<Contract["execution"]>["executionHash"];
            readonly mutations: {
              readonly defaults: readonly ExecutionDefaults<C, Ms>[];
            };
          };
        }),
  FixedMaps<C, Ms>
>;
interface DefineContract {
  <
    const T extends Types = Empty,
    const M extends Models = Empty,
    const E extends Extensions = undefined,
    const EN extends Enums = Empty,
  >(
    definition: Omit<
      Parameters<typeof nativeDefineContract<T, M, E, EN, Empty>>[0],
      "types" | "models" | "naming"
    > &
      IdentityNaming & { readonly types?: T; readonly models?: M },
  ): Materialize<
    AuthoredContract<
      ReturnType<typeof nativeDefineContract<T, M, E extends undefined ? Empty : E, EN, Empty>>,
      M
    >
  >;
  <
    const T extends Types = Empty,
    const M extends Models = Empty,
    const E extends Extensions = undefined,
    const SE extends Enums = Empty,
    const FE extends Enums = Empty,
  >(
    scaffold: Omit<Parameters<typeof nativeDefineContract<T, M, E, SE, FE>>[0], "naming"> &
      IdentityNaming,
    factory: (
      helpers: Helpers<
        Parameters<Parameters<typeof nativeDefineContract<T, M, NoInfer<E>, SE, FE>>[1]>[0]
      >,
    ) => { readonly types?: T; readonly models?: M; readonly enums?: FE },
  ): Materialize<
    AuthoredContract<
      ReturnType<typeof nativeDefineContract<T, M, E extends undefined ? Empty : E, SE, FE>>,
      M
    >
  >;
}
/**
 * Preserve native Prisma authoring types without generated application imports.
 * This is Prisma's own function; only its TypeScript declaration is adapted.
 * Upstream: https://github.com/prisma/orm/issues/30341.
 */
export const defineContract = nativeDefineContract as unknown as DefineContract;
