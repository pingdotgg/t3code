"use client";

import { useMemo, type ReactNode } from "react";
import type { SchemaFormControl as SchemaFormControlKind } from "@t3tools/contracts/schemaForm";

import { cn } from "../../lib/utils";
import type { ProviderClientDefinition } from "./providerDriverMeta";
import {
  getSchemaFormFieldLayout,
  readSchemaFormBoolean,
  readSchemaFormFieldValue,
  readSchemaFormString,
  SchemaFormFieldControl,
} from "./SchemaFormControl";
import { deriveSchemaFormFields, type SchemaFormFieldModel } from "./schemaForm";

type ProviderSettingsFormControl = Extract<
  SchemaFormControlKind,
  "text" | "password" | "textarea" | "switch"
>;

export type ProviderSettingsFieldModel = SchemaFormFieldModel<ProviderSettingsFormControl>;

interface ProviderSettingsValueField {
  readonly key: string;
  readonly control: ProviderSettingsFormControl;
  readonly label?: string | undefined;
  readonly clearWhenEmpty: "omit" | "persist";
  readonly defaultBooleanValue?: boolean | undefined;
}

export function deriveProviderSettingsFields(
  definition: ProviderClientDefinition,
): ReadonlyArray<ProviderSettingsFieldModel> {
  return deriveSchemaFormFields({
    schemas: [definition.settingsSchema],
    allowedControls: ["text", "password", "textarea", "switch"],
    includeUnannotatedFields: true,
    defaultControl: ({ inferredControl }) => {
      return inferredControl?.control === "switch" ? "switch" : "text";
    },
  });
}

export function readProviderConfigString(config: unknown, key: string): string {
  if (config === null || typeof config !== "object") return "";
  return readSchemaFormString((config as Record<string, unknown>)[key]);
}

export function readProviderConfigBoolean(
  config: unknown,
  key: string,
  defaultValue = false,
): boolean {
  if (config === null || typeof config !== "object") return defaultValue;
  return readSchemaFormBoolean((config as Record<string, unknown>)[key], defaultValue);
}

function readProviderConfigFieldValue(config: unknown, field: ProviderSettingsValueField) {
  if (config === null || typeof config !== "object") {
    return readSchemaFormFieldValue(field, undefined, field.defaultBooleanValue);
  }

  return readSchemaFormFieldValue(
    field,
    (config as Record<string, unknown>)[field.key],
    field.defaultBooleanValue,
  );
}

export function nextProviderConfigWithFieldValue(
  config: unknown,
  field: ProviderSettingsValueField,
  value: string | boolean,
): Record<string, unknown> | undefined {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};

  if (typeof value === "boolean") {
    const emptyBooleanValue = field.defaultBooleanValue ?? false;
    if (field.clearWhenEmpty === "omit" && value === emptyBooleanValue) {
      delete base[field.key];
    } else {
      base[field.key] = value;
    }
    return Object.keys(base).length > 0 ? base : undefined;
  }

  const trimmed = value.trim();
  if (field.clearWhenEmpty === "omit" && trimmed.length === 0) {
    delete base[field.key];
  } else {
    base[field.key] = value;
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

interface ProviderSettingsFormProps {
  readonly definition: ProviderClientDefinition;
  readonly value: unknown;
  readonly idPrefix: string;
  readonly variant: "card" | "dialog";
  readonly onChange: (nextConfig: Record<string, unknown> | undefined) => void;
}

function FieldFrame(props: {
  readonly variant: ProviderSettingsFormProps["variant"];
  readonly children: ReactNode;
}) {
  if (props.variant === "card") {
    return <div className="border-t border-border/60 px-4 py-3 sm:px-5">{props.children}</div>;
  }
  return <div className="grid gap-1.5">{props.children}</div>;
}

interface ProviderSettingsFieldRowProps {
  readonly field: ProviderSettingsFieldModel;
  readonly value: unknown;
  readonly idPrefix: string;
  readonly variant: ProviderSettingsFormProps["variant"];
  readonly onChange: ProviderSettingsFormProps["onChange"];
}

function ProviderSettingsFieldRow({
  field,
  value,
  idPrefix,
  variant,
  onChange,
}: ProviderSettingsFieldRowProps) {
  const inputId = `${idPrefix}-${field.key}`;
  const descriptionClassName =
    variant === "card"
      ? "mt-1 block text-xs text-muted-foreground"
      : "text-[11px] text-muted-foreground";
  const label = <span className="text-xs font-medium text-foreground">{field.label}</span>;
  const description = field.description ? (
    <span className={descriptionClassName}>{field.description}</span>
  ) : null;
  const control = (
    <SchemaFormFieldControl
      field={field}
      value={readProviderConfigFieldValue(value, field)}
      booleanDefault={field.defaultBooleanValue}
      id={inputId}
      className={variant === "card" ? "mt-1.5" : "bg-background"}
      commitOnBlur={variant === "card"}
      onChange={(next) => onChange(nextProviderConfigWithFieldValue(value, field, next))}
    />
  );

  if (getSchemaFormFieldLayout(field) === "inline") {
    return (
      <FieldFrame variant={variant}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {label}
            {description}
          </div>
          {control}
        </div>
      </FieldFrame>
    );
  }

  return (
    <FieldFrame variant={variant}>
      <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
        {label}
        {control}
        {description}
      </label>
    </FieldFrame>
  );
}

export function ProviderSettingsForm({
  definition,
  value,
  idPrefix,
  variant,
  onChange,
}: ProviderSettingsFormProps) {
  const fields = useMemo(() => deriveProviderSettingsFields(definition), [definition]);

  if (fields.length === 0) {
    return null;
  }

  return (
    <>
      {fields.map((field) => (
        <ProviderSettingsFieldRow
          key={field.key}
          field={field}
          value={value}
          idPrefix={idPrefix}
          variant={variant}
          onChange={onChange}
        />
      ))}
    </>
  );
}
