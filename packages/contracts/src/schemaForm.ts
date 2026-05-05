import * as Schema from "effect/Schema";

export type SchemaFormControl =
  | "select"
  | "switch"
  | "text"
  | "password"
  | "textarea"
  | "textGenerationModelSelection";

export type SchemaFormOptionLabels<Value extends string> = {
  readonly [Key in Value]: string;
};

export interface SchemaFormAnnotation {
  readonly control?: SchemaFormControl | undefined;
  readonly order?: number | undefined;
  readonly resetLabel?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly optionLabels?: Readonly<Record<string, string>> | undefined;
  readonly hidden?: boolean | undefined;
  readonly clearWhenEmpty?: "omit" | "persist" | undefined;
}

export interface SchemaFormSchemaAnnotation {
  readonly order?: readonly string[] | undefined;
}

export function schemaFormOptionLabels<const Literals extends readonly string[]>(
  _schema: Schema.Literals<Literals>,
  labels: SchemaFormOptionLabels<Literals[number]>,
): SchemaFormOptionLabels<Literals[number]> {
  return labels;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly schemaForm?: SchemaFormAnnotation | undefined;
      readonly schemaFormSchema?: SchemaFormSchemaAnnotation | undefined;
    }
  }
}
