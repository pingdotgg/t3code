type Integer =
  | "pg/int@1"
  | "pg/int2@1"
  | "pg/int4@1"
  | "pg/int8@1"
  | "pg/int8number@1"
  | "sql/int@1";
type Float = "pg/float@1" | "pg/float4@1" | "pg/float8@1" | "sql/float@1";
type Time = "pg/time-string@1" | "pg/time-temporal@1";
type Result<Output extends string, Nullable extends boolean = true> = {
  readonly output: Output;
  readonly nullable: Nullable;
};
type MapResult<Input extends string, Output extends string> = {
  readonly [K in Input]: Result<Output>;
};
type Identity<Input extends string> = { readonly [K in Input]: Result<K> };
type Ordered =
  | Integer
  | Float
  | Time
  | "pg/char@1"
  | "pg/date-string@1"
  | "pg/date-temporal@1"
  | "pg/enum@1"
  | "pg/inet@1"
  | "pg/interval@1"
  | "pg/numeric@1"
  | "pg/text-array@1"
  | "pg/text@1"
  | "pg/timestamp-string@1"
  | "pg/timestamp-temporal@1"
  | "pg/timestamptz-string@1"
  | "pg/timestamptz-temporal@1"
  | "pg/timetz@1"
  | "pg/unboundedint@1"
  | "sql/char@1"
  | "sql/text@1";
type MinMax = {
  readonly byCodec: Identity<Ordered> &
    MapResult<"pg/varchar@1" | "sql/varchar@1", "pg/text@1">;
};
type Count<Output extends string> = {
  readonly byCodec: {};
  readonly withoutInput: Result<Output, false>;
  readonly anyInput: Result<Output, false>;
};

// Prisma rc.11 exports aggregate descriptors at runtime but erases their literal types.
export type PostgresAggregateTypes = {
  readonly count: Count<"pg/int8number@1">;
  readonly countBigInt: Count<"pg/int8@1">;
  readonly min: MinMax;
  readonly max: MinMax;
  readonly avg: {
    readonly byCodec: MapResult<
      Integer | Float | "pg/unboundedint@1",
      "pg/float8@1"
    > &
      MapResult<Time, "pg/interval@1"> &
      Identity<"pg/numeric@1" | "pg/interval@1">;
  };
  readonly avgDecimal: {
    readonly byCodec: MapResult<
      Integer | "pg/unboundedint@1" | "pg/numeric@1",
      "pg/numeric@1"
    >;
  };
  readonly sum: {
    readonly byCodec: MapResult<Integer, "pg/int8number@1"> &
      MapResult<Exclude<Float, "pg/float4@1">, "pg/float8@1"> &
      Identity<"pg/float4@1"> &
      MapResult<Time, "pg/interval@1"> &
      Identity<"pg/numeric@1" | "pg/interval@1" | "pg/unboundedint@1">;
  };
  readonly sumBigInt: {
    readonly byCodec: MapResult<
      Exclude<Integer, "pg/int8@1" | "pg/int8number@1">,
      "pg/int8@1"
    > &
      MapResult<
        "pg/int8@1" | "pg/int8number@1" | "pg/unboundedint@1",
        "pg/unboundedint@1"
      >;
  };
};
