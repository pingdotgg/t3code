import { useState, type ReactNode } from "react";
import { isSecretReference, type EnvironmentId } from "@t3tools/contracts";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  readProviderConfigFieldBoolean,
  readProviderConfigFieldString,
  reconcileRowsDraft,
  seedRowsDraft,
  type ProviderSettingsFieldModel,
  type SettingsFormDefinition,
} from "@t3tools/client-runtime/settings/provider-form-fields";
import { PlusIcon, XIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { SecretInput } from "./SecretInput";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow } from "./settingsLayout";

export type {
  ProviderSettingsFieldModel,
  SettingsFormDefinition,
} from "@t3tools/client-runtime/settings/provider-form-fields";
export {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  reconcileRowsDraft,
  seedRowsDraft,
} from "@t3tools/client-runtime/settings/provider-form-fields";

const readProviderConfigString = readProviderConfigFieldString;
const readProviderConfigBoolean = readProviderConfigFieldBoolean;

export type { RowsDraft } from "@t3tools/client-runtime/settings/provider-form-fields";

let commandArgumentDraftId = 0;

const makeCommandArgumentDraftRow = (value: string) => ({
  id: `provider-argument-${commandArgumentDraftId++}`,
  value,
});

const toCommandArgumentRows = (args: ReadonlyArray<string>) =>
  args.map(makeCommandArgumentDraftRow);

function commandArgumentsEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>) {
  return left.length === right.length && left.every((argument, index) => argument === right[index]);
}

function configuredCommandArgs(value: ProviderSettingsFormProps["value"]) {
  const configured =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>).commandArgs
      : undefined;
  return Array.isArray(configured)
    ? configured.filter((argument): argument is string => typeof argument === "string")
    : [];
}

function ProviderCommandArguments({
  value,
  onChange,
  managedReason,
}: Pick<ProviderSettingsFormProps, "value" | "onChange"> & {
  readonly managedReason: string | undefined;
}) {
  const args = configuredCommandArgs(value);
  const [storedDraft, setDraft] = useState(() => seedRowsDraft(args, toCommandArgumentRows));
  const draft = reconcileRowsDraft(storedDraft, args, commandArgumentsEqual, toCommandArgumentRows);
  if (draft !== storedDraft) setDraft(draft);
  const rows = draft.rows;

  const updateArguments = (nextRows: typeof rows) => {
    const next = nextRows.map((row) => row.value);
    setDraft({ rows: nextRows, seen: draft.seen, lastPublished: next });
    const config =
      value !== null && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
    onChange({ ...config, commandArgs: next });
  };

  return (
    <SettingsRow
      title="Arguments"
      description="One literal argument per row, in launch order."
      managed={managedReason}
      control={
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => updateArguments([...rows, makeCommandArgumentDraftRow("")])}
        >
          <PlusIcon />
          Add argument
        </Button>
      }
    >
      {rows.length > 0 ? (
        <div className="mt-3 min-w-0 space-y-2 pb-2">
          {rows.map((argument, index) =>
            managedReason !== undefined ? (
              <code key={argument.id} className="block min-w-0 truncate text-xs">
                {argument.value}
              </code>
            ) : (
              <div key={argument.id} className="flex min-w-0 items-center gap-1.5">
                <DraftInput
                  size="sm"
                  font="mono"
                  value={argument.value}
                  onCommit={(next) =>
                    updateArguments(
                      rows.map((current) =>
                        current.id === argument.id ? { ...current, value: next } : current,
                      ),
                    )
                  }
                  aria-label={`Argument ${index + 1}`}
                  spellCheck={false}
                />
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-destructive"
                  onClick={() =>
                    updateArguments(rows.filter((current) => current.id !== argument.id))
                  }
                  aria-label={`Remove argument ${index + 1}`}
                >
                  <XIcon />
                </Button>
              </div>
            ),
          )}
        </div>
      ) : null}
    </SettingsRow>
  );
}

interface ProviderSettingsFormProps {
  readonly definition: SettingsFormDefinition;
  readonly value: unknown;
  readonly idPrefix: string;
  readonly variant: "card" | "dialog" | "settings";
  readonly onChange: (nextConfig: Record<string, unknown> | undefined) => void;
  /** Config keys an administrator's policy pins, shown inert with the reason. */
  readonly managed?: { readonly keys: ReadonlySet<string>; readonly reason: string } | undefined;
  /** Where the secret providers offered for `SettingsSecretValue` fields are configured. */
  readonly environmentId?: EnvironmentId | undefined;
}

function SecretSettingsControl({
  field,
  value,
  inputId,
  descriptionId,
  environmentId,
  onChange,
}: {
  readonly field: ProviderSettingsFieldModel;
  readonly value: unknown;
  readonly inputId: string;
  readonly descriptionId: string | undefined;
  readonly environmentId: EnvironmentId;
  readonly onChange: ProviderSettingsFormProps["onChange"];
}) {
  const sources = useSecretSources(environmentId);
  const saved =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)[field.key]
      : undefined;
  const reference = isSecretReference(saved) ? saved : undefined;
  const configured = reference !== undefined || (typeof saved === "string" && saved.length > 0);
  return (
    <div className="flex w-full min-w-0 items-start gap-2 @min-[32rem]/settings-row:w-80">
      <SecretSourceInput
        id={inputId}
        aria-describedby={descriptionId}
        aria-label={field.label}
        size="sm"
        className="min-w-0 flex-1"
        value={reference ?? ""}
        configured={reference === undefined && configured}
        sources={sources}
        onCommit={(next) => onChange(nextProviderConfigWithFieldValue(value, field, next))}
        onSecretChange={(secret) =>
          onChange(nextProviderConfigWithFieldValue(value, field, secret ?? ""))
        }
      />
      {configured ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost-destructive"
          onClick={() => onChange(nextProviderConfigWithFieldValue(value, field, ""))}
          aria-label={`Clear ${field.label}`}
        >
          <XIcon className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

function ProviderSettingsSelect({
  field,
  value,
  inputId,
  size,
  className,
  onChange,
}: {
  readonly field: ProviderSettingsFieldModel;
  readonly value: unknown;
  readonly inputId: string;
  readonly size: "sm" | "xs";
  readonly className?: string | undefined;
  readonly onChange: ProviderSettingsFormProps["onChange"];
}) {
  const options = field.options ?? [];
  const fallback = options[0]?.value ?? "";
  const current = readProviderConfigString(value, field.key) || fallback;
  const label = options.find((option) => option.value === current)?.label ?? current;
  return (
    <Select
      value={current}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        onChange(nextProviderConfigWithFieldValue(value, field, next === fallback ? "" : next));
      }}
    >
      <SelectTrigger id={inputId} size={size} className={className} aria-label={field.label}>
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function FieldFrame(props: {
  readonly variant: ProviderSettingsFormProps["variant"];
  readonly children: ReactNode;
}) {
  if (props.variant === "card") {
    return <div>{props.children}</div>;
  }
  return <div className="grid gap-1.5">{props.children}</div>;
}

interface ProviderSettingsFieldRowProps {
  readonly field: ProviderSettingsFieldModel;
  readonly value: unknown;
  readonly idPrefix: string;
  readonly variant: ProviderSettingsFormProps["variant"];
  readonly onChange: ProviderSettingsFormProps["onChange"];
  readonly managedReason?: string | undefined;
  readonly environmentId: EnvironmentId | undefined;
}

function ProviderSettingsFieldRow({
  field,
  value,
  idPrefix,
  variant,
  onChange,
  managedReason,
  environmentId,
}: ProviderSettingsFieldRowProps) {
  const inputId = `${idPrefix}-${field.key}`;
  const descriptionClassName =
    variant === "dialog"
      ? "text-2xs text-muted-foreground"
      : "mt-1 block text-xs text-muted-foreground";
  const label = <span className="text-xs font-medium text-foreground">{field.label}</span>;
  const description = field.description ? (
    <span className={descriptionClassName}>{field.description}</span>
  ) : null;

  if (variant === "settings") {
    const descriptionId = field.description ? `${inputId}-description` : undefined;
    const secretConfigured =
      field.secret === true && readProviderConfigString(value, field.key).length > 0;
    const control =
      field.control === "switch" ? (
        <Switch
          checked={readProviderConfigBoolean(value, field.key, field.defaultBooleanValue)}
          onCheckedChange={(checked) =>
            onChange(nextProviderConfigWithFieldValue(value, field, Boolean(checked)))
          }
          aria-label={field.label}
          aria-describedby={descriptionId}
        />
      ) : field.control === "select" ? (
        <ProviderSettingsSelect
          field={field}
          value={value}
          inputId={inputId}
          size="sm"
          className="w-full max-w-full @min-[32rem]/settings-row:w-56"
          onChange={onChange}
        />
      ) : field.control === "textarea" ? (
        <Textarea
          id={inputId}
          aria-describedby={descriptionId}
          className="w-full max-w-full @min-[32rem]/settings-row:w-[min(24rem,50cqw)]"
          value={readProviderConfigString(value, field.key)}
          onChange={(event) =>
            onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
          }
          placeholder={field.placeholder}
          spellCheck={false}
        />
      ) : field.acceptsSecretReference && environmentId !== undefined ? (
        <SecretSettingsControl
          field={field}
          value={value}
          inputId={inputId}
          descriptionId={descriptionId}
          environmentId={environmentId}
          onChange={onChange}
        />
      ) : field.secret ? (
        <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-56">
          <SecretInput
            id={inputId}
            aria-describedby={descriptionId}
            size="sm"
            className="min-w-0 flex-1"
            configured={secretConfigured}
            value=""
            onCommit={(next) => onChange(nextProviderConfigWithFieldValue(value, field, next))}
          />
          {secretConfigured ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost-destructive"
              onClick={() => onChange(nextProviderConfigWithFieldValue(value, field, ""))}
              aria-label={`Clear ${field.label}`}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      ) : (
        <DraftInput
          id={inputId}
          aria-describedby={descriptionId}
          size="sm"
          className="w-full max-w-full @min-[32rem]/settings-row:w-56"
          type={field.control === "password" ? "password" : undefined}
          autoComplete={field.control === "password" ? "off" : undefined}
          value={readProviderConfigString(value, field.key)}
          placeholder={field.placeholder}
          onCommit={(next) => {
            onChange(nextProviderConfigWithFieldValue(value, field, next));
          }}
          spellCheck={false}
        />
      );

    return (
      <SettingsRow
        title={
          field.control === "switch" ? field.label : <label htmlFor={inputId}>{field.label}</label>
        }
        description={
          field.description ? <span id={descriptionId}>{field.description}</span> : undefined
        }
        control={control}
        managed={managedReason}
      />
    );
  }

  if (field.control === "switch") {
    return (
      <FieldFrame variant={variant}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {label}
            {description}
          </div>
          <Switch
            checked={readProviderConfigBoolean(value, field.key, field.defaultBooleanValue)}
            onCheckedChange={(checked) =>
              onChange(nextProviderConfigWithFieldValue(value, field, Boolean(checked)))
            }
            aria-label={field.label}
          />
        </div>
      </FieldFrame>
    );
  }

  if (field.control === "select") {
    return (
      <FieldFrame variant={variant}>
        <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
          {label}
          <ProviderSettingsSelect
            field={field}
            value={value}
            inputId={inputId}
            size="sm"
            className={cn("w-full", variant === "card" && "mt-1.5")}
            onChange={onChange}
          />
          {description}
        </label>
      </FieldFrame>
    );
  }

  if (field.control === "textarea") {
    return (
      <FieldFrame variant={variant}>
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
  const BufferedInput = field.secret ? SecretInput : DraftInput;
  const ControlledInput = field.secret ? SecretInput : Input;
  return (
    <FieldFrame variant={variant}>
      <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
        {label}
        {variant === "card" ? (
          <BufferedInput
            id={inputId}
            size="sm"
            className="mt-1.5"
            type={field.secret ? undefined : type}
            autoComplete={!field.secret && field.control === "password" ? "off" : undefined}
            value={readProviderConfigString(value, field.key)}
            onCommit={(next) => onChange(nextProviderConfigWithFieldValue(value, field, next))}
            placeholder={field.placeholder}
            spellCheck={false}
          />
        ) : (
          <ControlledInput
            id={inputId}
            type={field.secret ? undefined : type}
            autoComplete={!field.secret && field.control === "password" ? "off" : undefined}
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
}

export function ProviderSettingsForm({
  definition,
  value,
  idPrefix,
  variant,
  onChange,
  managed,
  environmentId,
}: ProviderSettingsFormProps) {
  const fields = deriveProviderSettingsFields(definition, value);
  const isLocalAcp =
    definition.driverKind === "acpRegistry" &&
    readProviderConfigString(value, "source") === "local";

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
          managedReason={managed?.keys.has(field.key) ? managed.reason : undefined}
          environmentId={environmentId}
        />
      ))}
      {isLocalAcp ? (
        <ProviderCommandArguments
          value={value}
          onChange={onChange}
          managedReason={managed?.keys.has("commandArgs") ? managed.reason : undefined}
        />
      ) : null}
    </>
  );
}
