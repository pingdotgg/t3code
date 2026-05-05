"use client";

import { useMemo, type ReactNode } from "react";
import { Equal, Schema } from "effect";
import { ClientSettingsSchema, ServerSettings } from "@t3tools/contracts/settings";
import {
  schemaFormOptionLabels,
  type SchemaFormControl as SchemaFormControlKind,
} from "@t3tools/contracts/schemaForm";

import { SchemaFormFieldControl } from "./SchemaFormControl";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import {
  deriveSchemaFormFields,
  type SchemaFormFieldModel,
  type SchemaFormSchema,
} from "./schemaForm";

const ThemePreference = Schema.Literals(["system", "light", "dark"]);

type MainSettingsFormControl = Extract<
  SchemaFormControlKind,
  "select" | "switch" | "text" | "textGenerationModelSelection"
>;

export type MainSettingsFieldModel = SchemaFormFieldModel<MainSettingsFormControl>;

export const ThemeSettingsSchema = Schema.Struct({
  theme: ThemePreference.pipe(
    Schema.annotateKey({
      title: "Theme",
      description: "Choose how T3 Code looks across the app.",
      schemaForm: {
        order: 0,
        resetLabel: "theme",
        ariaLabel: "Theme preference",
        optionLabels: schemaFormOptionLabels(ThemePreference, {
          system: "System",
          light: "Light",
          dark: "Dark",
        }),
      },
    }),
  ),
});

export const MAIN_SETTINGS_FORM_SCHEMAS: readonly SchemaFormSchema[] = [
  ThemeSettingsSchema,
  ClientSettingsSchema,
  ServerSettings,
];

export function deriveMainSettingsFields(
  schemas: readonly SchemaFormSchema[] = MAIN_SETTINGS_FORM_SCHEMAS,
): ReadonlyArray<MainSettingsFieldModel> {
  return deriveSchemaFormFields({
    schemas,
    allowedControls: ["select", "switch", "text", "textGenerationModelSelection"],
    includeUnannotatedFields: false,
    sortByFormOrder: true,
  });
}

interface MainSettingsFormProps {
  readonly values: Readonly<Record<string, unknown>>;
  readonly defaultValues: Readonly<Record<string, unknown>>;
  readonly customControls?: Readonly<Record<string, ReactNode | undefined>> | undefined;
  readonly onChange: (key: string, value: unknown) => void;
}

export function MainSettingsForm({
  values,
  defaultValues,
  customControls,
  onChange,
}: MainSettingsFormProps) {
  const fields = useMemo(() => deriveMainSettingsFields(), []);

  return (
    <>
      {fields.map((field) => {
        const value = values[field.key];
        const defaultValue = defaultValues[field.key];
        const isDirty = !Equal.equals(value, defaultValue);
        return (
          <SettingsRow
            key={field.key}
            title={field.label}
            description={field.description ?? ""}
            resetAction={
              isDirty ? (
                <SettingResetButton
                  label={field.resetLabel}
                  onClick={() => onChange(field.key, defaultValue)}
                />
              ) : null
            }
            control={
              <SchemaFormFieldControl
                field={field}
                value={value}
                className="w-full sm:w-72"
                selectClassName="w-full sm:w-44"
                commitOnBlur
                customControls={customControls}
                onChange={(next) => onChange(field.key, next)}
              />
            }
          />
        );
      })}
    </>
  );
}
