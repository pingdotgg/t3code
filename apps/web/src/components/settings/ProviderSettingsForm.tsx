"use client";

import { useMemo, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import type {
  ProviderClientDefinition,
  ProviderSettingsControl,
  ProviderSettingsFieldUi,
} from "./providerDriverMeta";

export interface ProviderSettingsFieldModel {
  readonly key: string;
  readonly control: ProviderSettingsControl;
  readonly label: string;
  readonly description?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly clearWhenEmpty: "omit" | "persist";
}

function titleizeFieldKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (char) => char.toUpperCase());
}

function fieldControlFromUi(ui: ProviderSettingsFieldUi | undefined): ProviderSettingsControl {
  return ui?.control ?? "text";
}

export function deriveProviderSettingsFields(
  definition: ProviderClientDefinition,
): ReadonlyArray<ProviderSettingsFieldModel> {
  const schemaKeys = Object.keys(definition.settingsSchema.fields);
  const schemaKeySet = new Set(schemaKeys);
  const orderedKeys = [
    ...(definition.settingsUi.order ?? []).filter((key) => schemaKeySet.has(key)),
    ...schemaKeys.filter((key) => !(definition.settingsUi.order ?? []).includes(key)),
  ];

  return orderedKeys.flatMap((key) => {
    const ui = definition.settingsUi.fields?.[key];
    if (ui?.hidden) return [];
    return [
      {
        key,
        control: fieldControlFromUi(ui),
        label: ui?.label ?? titleizeFieldKey(key),
        ...(ui?.description !== undefined ? { description: ui.description } : {}),
        ...(ui?.placeholder !== undefined ? { placeholder: ui.placeholder } : {}),
        clearWhenEmpty: ui?.clearWhenEmpty ?? "omit",
      } satisfies ProviderSettingsFieldModel,
    ];
  });
}

export function readProviderConfigString(config: unknown, key: string): string {
  if (config === null || typeof config !== "object") return "";
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

export function readProviderConfigBoolean(config: unknown, key: string): boolean {
  if (config === null || typeof config !== "object") return false;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : false;
}

export function nextProviderConfigWithFieldValue(
  config: unknown,
  field: ProviderSettingsFieldModel,
  value: string | boolean,
): Record<string, unknown> | undefined {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};

  if (typeof value === "boolean") {
    base[field.key] = value;
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
      {fields.map((field) => {
        const inputId = `${idPrefix}-${field.key}`;
        const descriptionClassName =
          variant === "card"
            ? "mt-1 block text-xs text-muted-foreground"
            : "text-[11px] text-muted-foreground";
        const label = <span className="text-xs font-medium text-foreground">{field.label}</span>;
        const description = field.description ? (
          <span className={descriptionClassName}>{field.description}</span>
        ) : null;

        if (field.control === "switch") {
          return (
            <FieldFrame key={field.key} variant={variant}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  {label}
                  {description}
                </div>
                <Switch
                  checked={readProviderConfigBoolean(value, field.key)}
                  onCheckedChange={(checked) =>
                    onChange(nextProviderConfigWithFieldValue(value, field, Boolean(checked)))
                  }
                  aria-label={field.label}
                />
              </div>
            </FieldFrame>
          );
        }

        if (field.control === "textarea") {
          return (
            <FieldFrame key={field.key} variant={variant}>
              <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
                {label}
                <Textarea
                  id={inputId}
                  className={cn(variant === "card" && "mt-1.5")}
                  value={readProviderConfigString(value, field.key)}
                  onChange={(event) =>
                    onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
                  }
                  placeholder={field.placeholder}
                  spellCheck={false}
                />
                {description}
              </label>
            </FieldFrame>
          );
        }

        const type = field.control === "password" ? "password" : undefined;
        return (
          <FieldFrame key={field.key} variant={variant}>
            <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
              {label}
              {variant === "card" ? (
                <DraftInput
                  id={inputId}
                  className="mt-1.5"
                  type={type}
                  autoComplete={field.control === "password" ? "off" : undefined}
                  value={readProviderConfigString(value, field.key)}
                  onCommit={(next) =>
                    onChange(nextProviderConfigWithFieldValue(value, field, next))
                  }
                  placeholder={field.placeholder}
                  spellCheck={false}
                />
              ) : (
                <Input
                  id={inputId}
                  className="bg-background"
                  type={type}
                  autoComplete={field.control === "password" ? "off" : undefined}
                  value={readProviderConfigString(value, field.key)}
                  onChange={(event) =>
                    onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
                  }
                  placeholder={field.placeholder}
                  spellCheck={false}
                />
              )}
              {description}
            </label>
          </FieldFrame>
        );
      })}
    </>
  );
}
