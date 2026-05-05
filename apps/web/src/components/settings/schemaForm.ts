import { Schema } from "effect";
import type {
  SchemaFormAnnotation,
  SchemaFormControl,
  SchemaFormSchemaAnnotation,
} from "@t3tools/contracts/schemaForm";

export type SchemaFormSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;

export interface SchemaFormFieldEntry {
  readonly key: string;
  readonly fieldSchema: Schema.Top;
}

export interface SchemaFormFieldBase {
  readonly key: string;
  readonly label: string;
  readonly description?: string | undefined;
}

export interface SchemaFormSelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SchemaFormFieldModel<
  Control extends SchemaFormControl = SchemaFormControl,
> extends SchemaFormFieldBase {
  readonly control: Control;
  readonly resetLabel: string;
  readonly ariaLabel?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly options?: readonly SchemaFormSelectOption[] | undefined;
  readonly order: number;
  readonly clearWhenEmpty: "omit" | "persist";
  readonly defaultBooleanValue?: boolean | undefined;
}

export type InferredSchemaFormControl =
  | {
      readonly control: "switch";
    }
  | {
      readonly control: "select";
      readonly literalValues: readonly string[];
    }
  | {
      readonly control: "text";
    };

export function titleizeSchemaFieldKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (char) => char.toUpperCase());
}

export function readSchemaAnnotations(schema: Schema.Top) {
  return Schema.resolveAnnotationsKey(schema) ?? Schema.resolveAnnotations(schema);
}

export function readSchemaAnnotation<Annotation>(schema: Schema.Top, key: string) {
  return readSchemaAnnotations(schema)?.[key] as Annotation | undefined;
}

export function readSchemaAnnotationString(
  schema: Schema.Top,
  key: "title" | "description",
): string | undefined {
  const value = readSchemaAnnotations(schema)?.[key];
  return typeof value === "string" ? value : undefined;
}

export function makeSchemaFormFieldBase(key: string, fieldSchema: Schema.Top): SchemaFormFieldBase {
  const label = readSchemaAnnotationString(fieldSchema, "title") ?? titleizeSchemaFieldKey(key);
  const description = readSchemaAnnotationString(fieldSchema, "description");
  return {
    key,
    label,
    ...(description !== undefined ? { description } : {}),
  };
}

export function readSchemaFieldBooleanDefault(fieldSchema: Schema.Top): boolean | undefined {
  try {
    const decoded = Schema.decodeUnknownSync(fieldSchema as Schema.Decoder<unknown>)(undefined);
    return typeof decoded === "boolean" ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function inferSchemaFormControl(fieldSchema: Schema.Top): InferredSchemaFormControl | null {
  const ast = fieldSchema.ast;

  if (ast._tag === "Boolean") {
    return { control: "switch" };
  }

  if (ast._tag === "String") {
    return { control: "text" };
  }

  if (ast._tag === "Union") {
    const literalValues = ast.types.flatMap((type) => {
      if (type._tag !== "Literal" || typeof type.literal !== "string") return [];
      return [type.literal];
    });
    return literalValues.length === ast.types.length ? { control: "select", literalValues } : null;
  }

  return null;
}

export function orderedSchemaFieldEntries(
  schema: SchemaFormSchema,
  orderedKeys: readonly string[] = [],
): ReadonlyArray<SchemaFormFieldEntry> {
  const orderIndexes = new Map(orderedKeys.map((key, index) => [key, index] as const));
  const orderFallbackOffset = orderIndexes.size;

  return Object.keys(schema.fields)
    .map((key, index) => ({ key, index }))
    .toSorted((left, right) => {
      return (
        (orderIndexes.get(left.key) ?? orderFallbackOffset + left.index) -
        (orderIndexes.get(right.key) ?? orderFallbackOffset + right.index)
      );
    })
    .map(({ key }) => ({
      key,
      fieldSchema: schema.fields[key]!,
    }));
}

function readSchemaFormSchemaAnnotation(schema: SchemaFormSchema): SchemaFormSchemaAnnotation {
  return readSchemaAnnotation<SchemaFormSchemaAnnotation>(schema, "schemaFormSchema") ?? {};
}

function isAllowedSchemaFormControl<Control extends SchemaFormControl>(
  control: SchemaFormControl,
  allowedControls: readonly Control[],
): control is Control {
  return allowedControls.includes(control as Control);
}

interface DeriveSchemaFormFieldsOptions<Control extends SchemaFormControl> {
  readonly schemas: readonly SchemaFormSchema[];
  readonly allowedControls: readonly Control[];
  readonly includeUnannotatedFields: boolean;
  readonly sortByFormOrder?: boolean | undefined;
  readonly defaultControl?:
    | Control
    | ((input: {
        readonly key: string;
        readonly fieldSchema: Schema.Top;
        readonly inferredControl: InferredSchemaFormControl | null;
        readonly annotation: SchemaFormAnnotation | undefined;
      }) => Control | undefined)
    | undefined;
}

function resolveDefaultSchemaFormControl<Control extends SchemaFormControl>(
  options: DeriveSchemaFormFieldsOptions<Control>,
  input: {
    readonly key: string;
    readonly fieldSchema: Schema.Top;
    readonly inferredControl: InferredSchemaFormControl | null;
    readonly annotation: SchemaFormAnnotation | undefined;
  },
): Control | undefined {
  if (typeof options.defaultControl === "function") {
    return options.defaultControl(input);
  }
  return options.defaultControl;
}

export function deriveSchemaFormFields<Control extends SchemaFormControl>({
  schemas,
  allowedControls,
  includeUnannotatedFields,
  sortByFormOrder,
  defaultControl,
}: DeriveSchemaFormFieldsOptions<Control>): ReadonlyArray<SchemaFormFieldModel<Control>> {
  const fields = schemas.flatMap((schema) => {
    const schemaAnnotation = readSchemaFormSchemaAnnotation(schema);

    return orderedSchemaFieldEntries(schema, schemaAnnotation.order).flatMap(
      ({ key, fieldSchema }) => {
        const annotation = readSchemaAnnotation<SchemaFormAnnotation>(fieldSchema, "schemaForm");
        if (annotation?.hidden) return [];
        if (annotation === undefined && !includeUnannotatedFields) return [];

        const baseField = makeSchemaFormFieldBase(key, fieldSchema);
        const inferredControl = inferSchemaFormControl(fieldSchema);
        const control =
          annotation?.control ??
          resolveDefaultSchemaFormControl(
            { schemas, allowedControls, includeUnannotatedFields, sortByFormOrder, defaultControl },
            { key, fieldSchema, inferredControl, annotation },
          ) ??
          inferredControl?.control;
        if (control === undefined || !isAllowedSchemaFormControl(control, allowedControls)) {
          return [];
        }

        const selectOptions =
          control === "select" && inferredControl?.control === "select"
            ? inferredControl.literalValues.map((value) => ({
                value,
                label: annotation?.optionLabels?.[value] ?? value,
              }))
            : undefined;

        return [
          {
            ...baseField,
            control,
            resetLabel: annotation?.resetLabel ?? baseField.label.toLowerCase(),
            ...(annotation?.ariaLabel !== undefined ? { ariaLabel: annotation.ariaLabel } : {}),
            ...(annotation?.placeholder !== undefined
              ? { placeholder: annotation.placeholder }
              : {}),
            ...(selectOptions !== undefined ? { options: selectOptions } : {}),
            order: annotation?.order ?? Number.MAX_SAFE_INTEGER,
            clearWhenEmpty: annotation?.clearWhenEmpty ?? "omit",
            ...(control === "switch"
              ? { defaultBooleanValue: readSchemaFieldBooleanDefault(fieldSchema) }
              : {}),
          } satisfies SchemaFormFieldModel<Control>,
        ];
      },
    );
  });

  return sortByFormOrder ? fields.toSorted((left, right) => left.order - right.order) : fields;
}
