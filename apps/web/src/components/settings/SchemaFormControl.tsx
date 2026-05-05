"use client";

import type { ReactNode } from "react";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import type { SchemaFormSelectOption } from "./schemaForm";

export interface SchemaFormControlField {
  readonly key: string;
  readonly control: string;
  readonly label: string;
  readonly ariaLabel?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly options?: readonly SchemaFormSelectOption[] | undefined;
}

export function getSchemaFormFieldLayout(field: SchemaFormControlField): "inline" | "block" {
  return field.control === "switch" ? "inline" : "block";
}

export function readSchemaFormFieldValue(
  field: Pick<SchemaFormControlField, "control">,
  value: unknown,
  booleanDefault?: boolean | undefined,
): string | boolean {
  return field.control === "switch"
    ? readSchemaFormBoolean(value, booleanDefault)
    : readSchemaFormString(value);
}

type SchemaFormControlProps =
  | {
      readonly control: "switch";
      readonly checked: boolean;
      readonly ariaLabel: string;
      readonly onChange: (checked: boolean) => void;
    }
  | {
      readonly control: "select";
      readonly value: string;
      readonly options: readonly SchemaFormSelectOption[];
      readonly ariaLabel: string;
      readonly className?: string | undefined;
      readonly onChange: (value: string) => void;
    }
  | {
      readonly control: "text" | "password";
      readonly value: string;
      readonly id?: string | undefined;
      readonly className?: string | undefined;
      readonly placeholder?: string | undefined;
      readonly ariaLabel?: string | undefined;
      readonly spellCheck?: boolean | undefined;
      readonly commitOnBlur: boolean;
      readonly onChange: (value: string) => void;
    }
  | {
      readonly control: "textarea";
      readonly value: string;
      readonly id?: string | undefined;
      readonly className?: string | undefined;
      readonly placeholder?: string | undefined;
      readonly spellCheck?: boolean | undefined;
      readonly onChange: (value: string) => void;
    };

export function readSchemaFormString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function readSchemaFormBoolean(value: unknown, defaultValue = false): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

export function SchemaFormControl(props: SchemaFormControlProps) {
  if (props.control === "switch") {
    return (
      <Switch
        checked={props.checked}
        onCheckedChange={(checked) => props.onChange(Boolean(checked))}
        aria-label={props.ariaLabel}
      />
    );
  }

  if (props.control === "select") {
    const selectedLabel =
      props.options.find((option) => option.value === props.value)?.label ?? props.value;
    return (
      <Select
        value={props.value}
        onValueChange={(nextValue) => {
          if (
            typeof nextValue === "string" &&
            props.options.some((option) => option.value === nextValue)
          ) {
            props.onChange(nextValue);
          }
        }}
      >
        <SelectTrigger className={props.className} aria-label={props.ariaLabel}>
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {props.options.map((option) => (
            <SelectItem hideIndicator key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    );
  }

  if (props.control === "textarea") {
    return (
      <Textarea
        id={props.id}
        className={props.className}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
        spellCheck={props.spellCheck}
      />
    );
  }

  const type = props.control === "password" ? "password" : undefined;
  const autoComplete = props.control === "password" ? "off" : undefined;
  const commonProps = {
    id: props.id,
    className: props.className,
    type,
    autoComplete,
    value: props.value,
    placeholder: props.placeholder,
    spellCheck: props.spellCheck,
    "aria-label": props.ariaLabel,
  };

  if (props.commitOnBlur) {
    return <DraftInput {...commonProps} onCommit={props.onChange} />;
  }

  return <Input {...commonProps} onChange={(event) => props.onChange(event.target.value)} />;
}

export function SchemaFormFieldControl({
  field,
  value,
  booleanDefault,
  id,
  className,
  selectClassName,
  commitOnBlur,
  customControls,
  onChange,
}: {
  readonly field: SchemaFormControlField;
  readonly value: unknown;
  readonly booleanDefault?: boolean | undefined;
  readonly id?: string | undefined;
  readonly className?: string | undefined;
  readonly selectClassName?: string | undefined;
  readonly commitOnBlur?: boolean | undefined;
  readonly customControls?: Readonly<Record<string, ReactNode | undefined>> | undefined;
  readonly onChange: (value: string | boolean) => void;
}) {
  const ariaLabel = field.ariaLabel ?? field.label;

  if (field.control === "switch") {
    return (
      <SchemaFormControl
        control="switch"
        checked={readSchemaFormFieldValue(field, value, booleanDefault) === true}
        ariaLabel={ariaLabel}
        onChange={onChange}
      />
    );
  }

  if (field.control === "select") {
    return (
      <SchemaFormControl
        control="select"
        value={String(readSchemaFormFieldValue(field, value))}
        options={field.options ?? []}
        className={selectClassName ?? className}
        ariaLabel={ariaLabel}
        onChange={onChange}
      />
    );
  }

  if (field.control === "text" || field.control === "password") {
    return (
      <SchemaFormControl
        control={field.control}
        id={id}
        className={className}
        value={String(readSchemaFormFieldValue(field, value))}
        commitOnBlur={commitOnBlur ?? false}
        placeholder={field.placeholder}
        spellCheck={false}
        ariaLabel={ariaLabel}
        onChange={onChange}
      />
    );
  }

  if (field.control === "textarea") {
    return (
      <SchemaFormControl
        control="textarea"
        id={id}
        className={className}
        value={String(readSchemaFormFieldValue(field, value))}
        placeholder={field.placeholder}
        spellCheck={false}
        onChange={onChange}
      />
    );
  }

  return customControls?.[field.key] ?? null;
}
