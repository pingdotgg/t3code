import type { Effect } from "effect/Effect";
import * as S from "effect/Schema";
import * as AST from "effect/SchemaAST";
import type { Sink } from "effect/Sink";
import type { Stream } from "effect/Stream";

export * from "effect/Schema";

export const isNullishSchema = (schema: S.Schema<any>) =>
  isNullSchema(schema) || isUndefinedSchema(schema);
export const isNullSchema = (schema: S.Schema<any>) => AST.isNull(schema.ast);
export const isUndefinedSchema = (schema: S.Schema<any>) =>
  AST.isUndefined(schema.ast);
export const isBooleanSchema = (schema: S.Schema<any>) =>
  AST.isBoolean(schema.ast);
export const isStringSchema = (schema: S.Schema<any>) =>
  AST.isString(schema.ast);
export const isNumberSchema = (schema: S.Schema<any>) =>
  AST.isNumber(schema.ast);

export const isRecordLikeSchema = (schema: S.Schema<any>) =>
  isMapSchema(schema) ||
  isRecordSchema(schema) ||
  isStructSchema(schema) ||
  isClassSchema(schema) ||
  false;

export const isMapSchema = (schema: S.Schema<any>): boolean => {
  const ast = schema.ast;
  if (AST.isDeclaration(ast)) {
    const typeConstructor = (ast.annotations as any)?.typeConstructor;
    return typeConstructor?._tag === "ReadonlyMap";
  }
  return false;
};

export const isClassSchema = (schema: S.Schema<any>) => {
  const ast = schema.ast;
  if (AST.isDeclaration(ast)) {
    return AST.isObjects(ast.typeParameters[0]);
  }
  return false;
};

export const isStructSchema = (schema: S.Schema<any>) => {
  return AST.isObjects(schema.ast);
};

export const isRecordSchema = (schema: S.Schema<any>) => {
  const ast = schema.ast;
  return AST.isObjects(ast) && ast.indexSignatures?.length > 0;
};

export const isListSchema = (schema: S.Schema<any>) => {
  return AST.isArrays(schema.ast);
};

export const isSetSchema = (schema: S.Schema<any>): boolean => {
  const ast = schema.ast;
  if (AST.isDeclaration(ast)) {
    const typeConstructor = (ast.annotations as any)?.typeConstructor;
    return typeConstructor?._tag === "ReadonlySet";
  }
  return false;
};

export const getSetValueAST = (schema: S.Schema<any>): AST.AST | undefined => {
  const ast = schema.ast;
  if (AST.isDeclaration(ast) && isSetSchema(schema)) {
    return ast.typeParameters[0];
  }
  return undefined;
};

/** A Schema representing a Schema */
export type Field = S.Top;
export const Field = S.suspend(
  (): [Field] extends [any] ? S.Schema<Field> : never => S.Any,
);

type FunctionType = (...args: any[]) => any;
export type Function<F extends FunctionType = FunctionType> = S.Schema<F>;
export const Function: <F extends FunctionType>() => Function<F> = S.suspend(
  (): S.Schema<FunctionType> => S.Any,
) as any;

export type CreatedAt = Date;
export const CreatedAt = S.Date.annotate({
  description: "The timestamp of when this record was created",
});

export type UpdatedAt = Date;
export const UpdatedAt = S.Date.annotate({
  description: "The timestamp of when this record was last updated",
});

export type AnyClassSchema<
  Self = any,
  Fields extends S.Top & { fields: S.Struct.Fields } = S.Top & {
    fields: S.Struct.Fields;
  },
> = S.Class<Self, Fields, any>;

export type AnyClass = new (...args: any[]) => any;

export type AnyErrorSchema = S.Class<any, any, any>;

export type SchemaWithTemplate<
  Schema extends S.Schema<any>,
  References extends any[] = any[],
> = Schema & {
  template: TemplateStringsArray;
  references: References;
};

export type SchemaExt =
  | FunctionSchema
  | EffectSchema
  | StreamSchema
  | SinkSchema;

export interface SchemaExtBase<A> extends S.Schema<A> {
  <References extends any[]>(
    template: TemplateStringsArray,
    ...references: References
  ): SchemaWithTemplate<this, References>;
}

export interface FunctionSchema<
  Input extends S.Top | undefined = S.Top | undefined,
  Output extends S.Top = S.Top,
> extends SchemaExtBase<
  (
    ...args: Input extends undefined
      ? []
      : [input: S.Schema.Type<Exclude<Input, undefined>>]
  ) => S.Schema.Type<Output>
> {
  input: Input;
  output: Output;
}

export interface EffectSchema<
  A extends S.Top = S.Top,
  Err extends S.Top = S.Top,
  Req extends S.Top = S.Top,
> extends SchemaExtBase<
  Effect<S.Schema.Type<A>, S.Schema.Type<Err>, S.Schema.Type<Req>>
> {
  A: A;
  Err: Err;
  Req: Req;
}

export interface StreamSchema<
  A extends S.Top = S.Top,
  Err extends S.Top = S.Top,
  Req extends S.Top = S.Top,
> extends SchemaExtBase<
  Stream<S.Schema.Type<A>, S.Schema.Type<Err>, S.Schema.Type<Req>>
> {
  A: A;
  Err: Err;
  Req: Req;
}

export interface SinkSchema<
  A extends S.Top = S.Top,
  In extends S.Top = S.Top,
  L extends S.Top = S.Top,
  Err extends S.Top = S.Top,
  Req extends S.Top = S.Top,
> extends SchemaExtBase<
  Sink<
    S.Schema.Type<A>,
    S.Schema.Type<In>,
    S.Schema.Type<L>,
    S.Schema.Type<Err>,
    S.Schema.Type<Req>
  >
> {
  A: A;
  In: In;
  L: L;
  Err: Err;
  Req: Req;
}

export const makeExtSchema = <Schema extends SchemaExt>(
  schema: Schema,
): SchemaExt => {
  const s = S.Any.annotate({
    aspect: schema,
  });
  return new Proxy(() => {}, {
    get: (_target, prop) => s[prop as keyof typeof s],
    apply: (_target, _thisArg, [template, ...references]) => {
      return S.annotate({
        aspect: {
          ...schema,
          template,
          references,
        },
      });
    },
  }) as any as SchemaExt;
};

// export type def = typeof def;

export interface func<
  Input extends undefined | S.Top | S.Top[],
  Output extends S.Top,
> extends S.Schema<
  Input extends undefined
    ? () => S.Schema.Type<Output>
    : Input extends S.Top[]
      ? (...args: TypeArray<Input>) => S.Schema.Type<Output>
      : (input: S.Schema.Type<Extract<Input, S.Top>>) => S.Schema.Type<Output>
> {}

type TypeArray<T extends S.Top[]> = T extends [
  infer Head,
  ...infer Tail extends S.Top[],
]
  ? Head extends S.Top
    ? [S.Schema.Type<Head>, ...TypeArray<Tail>]
    : never
  : [];

export const func: {
  <Output extends S.Schema<any>>(
    output: Output,
  ): func<undefined, Output> & {
    <R extends any[]>(
      template: TemplateStringsArray,
      ...references: R
    ): SchemaWithTemplate<func<undefined, Output>, R>;
  };
  <Input extends S.Schema<any>, Output extends S.Schema<any>>(
    input: Input,
    output: Output,
  ): func<Input, Output> & {
    <R extends any[]>(
      template: TemplateStringsArray,
      ...references: R
    ): SchemaWithTemplate<func<Input, Output>, R>;
  };
  <const Args extends S.Schema<any>[], Output extends S.Schema<any>>(
    args: Args,
    output: Output,
  ): func<Args, Output> & {
    <R extends any[]>(
      template: TemplateStringsArray,
      ...references: R
    ): SchemaWithTemplate<func<Args, Output>, R>;
  };
} = ((input: any, output: any) =>
  S.Any.annotate({
    aspect: {
      type: "fn",
      input: output ? input : undefined,
      output: output ?? input,
    },
  })) as any;

export interface effect<
  A extends S.Top,
  Err extends S.Top,
  Req extends S.Top,
> extends S.Schema<
  Effect<S.Schema.Type<A>, S.Schema.Type<Err>, S.Schema.Type<Req>>
> {}

export const effect = <
  A extends S.Schema<any>,
  Err extends S.Schema<any> | S.Never = S.Never,
  Req extends S.Schema<any> | S.Any = S.Any,
>(
  a: A,
  err: Err = S.Never as any,
  req: Req = S.Never as any,
): effect<A, Err, Req> =>
  S.Any.annotate({
    aspect: {
      type: "effect",
      a: a,
      err: err,
      req: req,
    },
  });

export const stream = <
  A extends S.Schema<any>,
  Err extends S.Schema<any> | S.Never = S.Never,
  Req extends S.Schema<any> | S.Never = S.Never,
>(
  a: A,
  err: Err = S.Never as any,
  req: Req = S.Never as any,
) =>
  S.Any.annotate({
    aspect: {
      type: "stream",
      a: a,
      err: err,
      req: req,
    },
  });

export const sink = <
  A extends S.Schema<any>,
  In extends S.Schema<any>,
  L extends S.Schema<any>,
  Err extends S.Schema<any> | S.Never = S.Never,
  Req extends S.Schema<any> | S.Never = S.Never,
>(
  a: A,
  _in: In = S.Never as any,
  l: L = S.Never as any,
  err: Err = S.Never as any,
  req: Req = S.Never as any,
) =>
  S.Any.annotate({
    aspect: {
      type: "sink",
      a: a,
      in: _in,
      l: l,
      err: err,
      req: req,
    },
  });
