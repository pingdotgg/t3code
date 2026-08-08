import * as S from "effect/Schema";

export type Parameter<
  Name extends string = string,
  Schema extends S.Top = S.Top,
  Refs extends any[] = any[],
> = {
  "~alchemy/Kind": "Param";
  "~alchemy/Name": Name;
  schema: Schema;
  template: TemplateStringsArray;
  refs: Refs;
};

export const Parameter: {
  <const Name extends string>(
    name: Name,
  ): {
    <Schema extends S.Top>(
      schema: Schema,
    ): {
      <Refs extends any[]>(
        template: TemplateStringsArray,
        ...refs: Refs
      ): Parameter<Name, Schema, Refs>;
    };
  };
  <const Name extends string, Schema extends S.Top>(
    name: Name,
    schema: Schema,
  ): {
    <Refs extends any[]>(
      template: TemplateStringsArray,
      ...refs: Refs
    ): Parameter<Name, Schema, Refs>;
  };
} = ((name: string, schema?: S.Top) =>
  schema
    ? (template: TemplateStringsArray, ...refs: any[]) =>
        makeParameter(name, schema, template, refs)
    : (schema: S.Top) =>
        (template: TemplateStringsArray, ...refs: any[]) =>
          makeParameter(name, schema, template, refs)) as any;

const makeParameter = (
  name: string,
  schema: S.Top,
  template: TemplateStringsArray,
  refs: any[],
) =>
  Object.assign(function () {}, {
    "~alchemy/Kind": "Param",
    "~alchemy/Name": name,
    schema,
    template,
    refs,
  }) as any;
