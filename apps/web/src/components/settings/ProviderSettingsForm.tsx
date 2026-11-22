import { useState, type ReactNode } from "react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  acceptsSecretReference,
  isSecretReference,
  isSecretSetting,
  type EnvironmentId,
  type ProviderSettingsFormAnnotation,
  type ProviderSettingsFormControl,
  type ProviderSettingsFormOption,
  type ProviderSettingsFormSchemaAnnotation,
  type SecretReference,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { PlusIcon, XIcon } from "lucide-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { SecretInput } from "./SecretInput";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import type { ProviderClientDefinition } from "@t3tools/provider-core/client";

export type SettingsFormDefinition = Pick<ProviderClientDefinition, "settingsSchema"> & {
  readonly driverKind?: ProviderClientDefinition["driverKind"];
};
import { SettingsRow } from "./settingsLayout";

export interface ProviderSettingsFieldModel {
  readonly key: string;
  readonly control: ProviderSettingsFormControl;
  readonly label: string;
  readonly description?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly clearWhenEmpty: "omit" | "persist";
  /** Kept in the server's secret store: a saved value arrives as `SECRET_REDACTED` and never shows. */
  readonly secret?: boolean | undefined;
  /** Typed `SettingsSecretValue`: may name a secret provider reference instead of a value. */
  readonly acceptsSecretReference?: boolean | undefined;
  readonly defaultBooleanValue?: boolean | undefined;
  /** Whether the field's schema decodes a typed string; one it rejects is never stored. */
  readonly accepts?: ((value: string) => boolean) | undefined;

  readonly options?: ReadonlyArray<ProviderSettingsFormOption> | undefined;
}

function titleizeFieldKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (char) => char.toUpperCase());
}

function readFieldAnnotations(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
) {
  return Schema.resolveAnnotationsKey(fieldSchema) ?? Schema.resolveAnnotations(fieldSchema);
}

function readFieldAnnotationString(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
  key: "title" | "description",
): string | undefined {
  const annotations = readFieldAnnotations(fieldSchema);
  const value = annotations?.[key];
  return typeof value === "string" ? value : undefined;
}

function readProviderSettingsFormAnnotation(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
): ProviderSettingsFormAnnotation {
  const annotation = readFieldAnnotations(fieldSchema)?.providerSettingsForm;
  return annotation ?? {};
}

function readProviderSettingsFormSchemaAnnotation(
  definition: SettingsFormDefinition,
): ProviderSettingsFormSchemaAnnotation {
  return Schema.resolveAnnotations(definition.settingsSchema)?.providerSettingsFormSchema ?? {};
}

function readFieldBooleanDefault(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
): boolean | undefined {
  const decodeDefault = Schema.decodeUnknownOption(fieldSchema as Schema.Decoder<unknown>);
  const decoded = decodeDefault(undefined);
  return Option.isSome(decoded) && typeof decoded.value === "boolean" ? decoded.value : undefined;
}

function fieldAcceptsString(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
): (value: string) => boolean {
  const decode = Schema.decodeUnknownOption(fieldSchema as Schema.Decoder<unknown>);
  return (value) => Option.isSome(decode(value));
}

// Field text authored in contracts and the provider and source-control packages, which the server
// also imports. Keyed by that English; text not listed here shows as authored.
const PACKAGE_FIELD_TEXT: ReadonlyMap<string, string> = new Map([
  ["Binary path", msg("Binary path")],
  ["CODEX_HOME path", msg("CODEX_HOME path")],
  ["Shadow home path", msg("Shadow home path")],
  ["Launch arguments", msg("Launch arguments")],
  ["CLAUDE_CONFIG_DIR path", msg("CLAUDE_CONFIG_DIR path")],
  ["Auto-compact after", msg("Auto-compact after")],
  ["Compact idle threads", msg("Compact idle threads")],
  ["Sign-in method", msg("Sign-in method")],
  ["API key", msg("API key")],
  ["GCP project", msg("GCP project")],
  ["GCP location", msg("GCP location")],
  ["ACP source", msg("ACP source")],
  ["Registry agent ID", msg("Registry agent ID")],
  ["Executable override", msg("Executable override")],
  ["Authentication method", msg("Authentication method")],
  ["Server URL", msg("Server URL")],
  ["Server password", msg("Server password")],
  ["Access token", msg("Access token")],
  ["Atlassian account email", msg("Atlassian account email")],
  ["API token", msg("API token")],
  ["Token", msg("Token", { $context: "settings field, an access token" })],
  [
    "Path to the Codex binary used by this instance.",
    msg("Path to the Codex binary used by this instance."),
  ],
  ["Custom Codex home and config directory.", msg("Custom Codex home and config directory.")],
  [
    "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.",
    msg(
      "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.",
    ),
  ],
  [
    "Additional CLI arguments passed to codex app-server on session start.",
    msg("Additional CLI arguments passed to codex app-server on session start."),
  ],
  [
    "Path to the Claude binary used by this instance.",
    msg("Path to the Claude binary used by this instance."),
  ],
  [
    "Custom Claude home and config directory. Keeps .claude.json and .claude separate.",
    msg("Custom Claude home and config directory. Keeps .claude.json and .claude separate."),
  ],
  [
    "Additional CLI arguments passed on session start.",
    msg("Additional CLI arguments passed on session start."),
  ],
  [
    "Compact after 100,000 to 1,000,000 tokens. Leave empty to use Claude's default.",
    msg("Compact after 100,000 to 1,000,000 tokens. Leave empty to use Claude's default."),
  ],
  [
    "When to compact an idle thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Overrides the default in Providers > Advanced.",
    msg(
      "When to compact an idle thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Overrides the default in Providers > Advanced.",
    ),
  ],
  ["Stop at plan limit", msg("Stop at plan limit")],
  [
    "Stop the turn when a plan limit is reached instead of continuing on extra usage. Snooze and auto-resume treat it as a usage limit.",
    msg(
      "Stop the turn when a plan limit is reached instead of continuing on extra usage. Snooze and auto-resume treat it as a usage limit.",
    ),
  ],
  [
    "Google accounts use your subscription; API keys and Agent Platform bill usage.",
    msg("Google accounts use your subscription; API keys and Agent Platform bill usage."),
  ],
  [
    "Gemini or Vertex AI express key. Stored separately on the host.",
    msg("Gemini or Vertex AI express key. Stored separately on the host."),
  ],
  [
    "Required for Gemini Enterprise. Agent Platform uses it when no API key is set.",
    msg("Required for Gemini Enterprise. Agent Platform uses it when no API key is set."),
  ],
  [
    "Region for Gemini Enterprise or Agent Platform.",
    msg("Region for Gemini Enterprise or Agent Platform."),
  ],
  [
    "Custom ACP executable. Leave empty to select automatically.",
    msg("Custom ACP executable. Leave empty to select automatically."),
  ],
  [
    "Agent identifier from the official ACP Registry, for example 'devin'.",
    msg("Agent identifier from the official ACP Registry, for example 'devin'."),
  ],
  [
    "Executable on this environment. For registry agents, this overrides the distribution executable while keeping its arguments and environment.",
    msg(
      "Executable on this environment. For registry agents, this overrides the distribution executable while keeping its arguments and environment.",
    ),
  ],
  [
    "Optional ACP authentication method ID. By default, the first agent-managed method is selected.",
    msg(
      "Optional ACP authentication method ID. By default, the first agent-managed method is selected.",
    ),
  ],
  [
    "Path to the fx binary. All fx instances on this machine share its fx login.",
    msg("Path to the fx binary. All fx instances on this machine share its fx login."),
  ],
  ["Path to the Grok CLI binary.", msg("Path to the Grok CLI binary.")],
  ["Path to the Kiro CLI binary.", msg("Path to the Kiro CLI binary.")],
  [
    "Path to the Muse Code binary on this environment. Sign in with muse login on that host.",
    msg("Path to the Muse Code binary on this environment. Sign in with muse login on that host."),
  ],
  ["Path to the OpenCode binary.", msg("Path to the OpenCode binary.")],
  [
    "Leave blank to let T3 Code spawn the server when needed.",
    msg("Leave blank to let T3 Code spawn the server when needed."),
  ],
  ["Stored separately on the host.", msg("Stored separately on the host.")],
  ["Path to the Pi coding agent binary.", msg("Path to the Pi coding agent binary.")],
  [
    "Additional CLI arguments passed to pi --mode rpc on session start.",
    msg("Additional CLI arguments passed to pi --mode rpc on session start."),
  ],
  [
    "Scoped to one repository, project, or workspace. Create it in that item's Bitbucket settings.",
    msg(
      "Scoped to one repository, project, or workspace. Create it in that item's Bitbucket settings.",
    ),
  ],
  [
    "With an API token instead of an access token.",
    msg("With an API token instead of an access token."),
  ],
  [
    "Reaches every repository your Atlassian account can. Give it read and write access to repositories and pull requests, plus read:user:bitbucket and read:workspace:bitbucket.",
    msg(
      "Reaches every repository your Atlassian account can. Give it read and write access to repositories and pull requests, plus read:user:bitbucket and read:workspace:bitbucket.",
    ),
  ],
  [
    "A git.cafe token, used before CAFE_TOKEN and the cafe login, so GitCafe works without the CLI signed in.",
    msg(
      "A git.cafe token, used before CAFE_TOKEN and the cafe login, so GitCafe works without the CLI signed in.",
    ),
  ],
  ["e.g. --chrome", msg("e.g. --chrome")],
  ["e.g. 300000", msg("e.g. 300000")],
  ["Optional", msg("Optional", { $context: "placeholder of an optional settings field" })],
  ["Automatic", msg("Automatic", { $context: "placeholder, chosen automatically when empty" })],
  ["Registry default", msg("Registry default")],
  ["When you return", msg("When you return")],
  ["Before the cache expires (beta)", msg("Before the cache expires (beta)")],
  ["Never", msg("Never", { $context: "option, never compact idle threads" })],
  ["Use default", msg("Use default")],
  ["Google account", msg("Google account")],
  ["Gemini API key", msg("Gemini API key")],
  ["Local command", msg("Local command")],
]);

function packageFieldText(text: string, resolve: MessageResolver): string {
  const entry = PACKAGE_FIELD_TEXT.get(text);
  return entry === undefined ? text : resolve(entry);
}

export function deriveProviderSettingsFields(
  definition: SettingsFormDefinition,
  value?: unknown,
  resolve: MessageResolver = m,
): ReadonlyArray<ProviderSettingsFieldModel> {
  const isLocalAcp =
    definition.driverKind === "acpRegistry" &&
    readProviderConfigString(value, "source") === "local";
  const schemaAnnotation = readProviderSettingsFormSchemaAnnotation(definition);
  const orderedKeys = new Map(
    (schemaAnnotation.order ?? []).map((key, index) => [key, index] as const),
  );
  const orderFallbackOffset = orderedKeys.size;

  return Object.keys(definition.settingsSchema.fields)
    .map((key, index) => ({ key, index }))
    .toSorted((left, right) => {
      return (
        (orderedKeys.get(left.key) ?? orderFallbackOffset + left.index) -
        (orderedKeys.get(right.key) ?? orderFallbackOffset + right.index)
      );
    })
    .flatMap(({ key }) => {
      const fieldSchema = definition.settingsSchema.fields[key]!;
      const formAnnotation = readProviderSettingsFormAnnotation(fieldSchema);
      if (formAnnotation.hidden) return [];
      if (isLocalAcp && key !== "source" && key !== "commandPath") return [];

      const annotatedTitle = readFieldAnnotationString(fieldSchema, "title");
      const annotatedDescription = readFieldAnnotationString(fieldSchema, "description");
      return [
        {
          key,
          control: formAnnotation.control ?? "text",
          label:
            isLocalAcp && key === "commandPath"
              ? resolve(msg("Executable"))
              : annotatedTitle !== undefined
                ? packageFieldText(annotatedTitle, resolve)
                : titleizeFieldKey(key),
          ...(isLocalAcp && key === "commandPath"
            ? { description: resolve(msg("Executable name or path on this environment.")) }
            : annotatedDescription !== undefined
              ? { description: packageFieldText(annotatedDescription, resolve) }
              : {}),
          ...(isLocalAcp && key === "commandPath"
            ? { placeholder: resolve(msg("e.g. dsh")) }
            : formAnnotation.placeholder !== undefined
              ? { placeholder: packageFieldText(formAnnotation.placeholder, resolve) }
              : {}),
          clearWhenEmpty: formAnnotation.clearWhenEmpty ?? "omit",
          ...(isSecretSetting(fieldSchema) ? { secret: true } : {}),
          ...(acceptsSecretReference(fieldSchema) ? { acceptsSecretReference: true } : {}),
          ...(formAnnotation.control === "switch"
            ? { defaultBooleanValue: readFieldBooleanDefault(fieldSchema) }
            : {}),
          accepts: fieldAcceptsString(fieldSchema),
          ...(formAnnotation.control === "select" && formAnnotation.options
            ? {
                options: formAnnotation.options.map((option) => ({
                  ...option,
                  label: packageFieldText(option.label, resolve),
                })),
              }
            : {}),
        } satisfies ProviderSettingsFieldModel,
      ];
    });
}

let commandArgumentDraftId = 0;
/**
 * Editable rows seeded from a configured value. `seen` is the value the rows
 * were last reconciled against; `lastPublished` is what the rows last sent to
 * the owner, so its echo does not reseed rows (and drop their ids) mid-edit.
 */
export interface RowsDraft<V, R> {
  readonly rows: ReadonlyArray<R>;
  readonly seen: V;
  readonly lastPublished: V | undefined;
}

export function seedRowsDraft<V, R>(
  value: V,
  toRows: (value: V) => ReadonlyArray<R>,
): RowsDraft<V, R> {
  return { rows: toRows(value), seen: value, lastPublished: undefined };
}

/** Reseeds the rows when the configured value changes from outside this editor. */
export function reconcileRowsDraft<V, R>(
  draft: RowsDraft<V, R>,
  incoming: V,
  equal: (left: V, right: V) => boolean,
  toRows: (value: V) => ReadonlyArray<R>,
): RowsDraft<V, R> {
  if (draft.seen === incoming || equal(draft.seen, incoming)) return draft;
  const echo = draft.lastPublished !== undefined && equal(draft.lastPublished, incoming);
  return { rows: echo ? draft.rows : toRows(incoming), seen: incoming, lastPublished: undefined };
}

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
  const gt = useGT();
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
      title={gt("Arguments")}
      description={gt("One literal argument per row, in launch order.")}
      managed={managedReason}
      control={
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => updateArguments([...rows, makeCommandArgumentDraftRow("")])}
        >
          <PlusIcon />
          <T>Add argument</T>
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
                  aria-label={gt("Argument {number}", { number: index + 1 })}
                  spellCheck={false}
                />
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-destructive"
                  onClick={() =>
                    updateArguments(rows.filter((current) => current.id !== argument.id))
                  }
                  aria-label={gt("Remove argument {number}", { number: index + 1 })}
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

function readProviderConfigString(config: unknown, key: string): string {
  if (config === null || typeof config !== "object") return "";
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function readProviderConfigBoolean(config: unknown, key: string, defaultValue = false): boolean {
  if (config === null || typeof config !== "object") return defaultValue;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : defaultValue;
}

export function nextProviderConfigWithFieldValue(
  config: unknown,
  field: ProviderSettingsFieldModel,
  value: string | boolean | SecretReference,
): Record<string, unknown> | undefined {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};

  if (typeof value === "object") {
    base[field.key] = value;
    return base;
  }

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
  } else if (field.accepts?.(value) !== false) {
    base[field.key] = value;
  }
  return Object.keys(base).length > 0 ? base : undefined;
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
  const gt = useGT();
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
        environmentId={environmentId}
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
          aria-label={gt("Clear {field}", { field: field.label })}
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

function ProviderSettingsTextInput({
  field,
  value,
  inputId,
  descriptionId,
  onChange,
}: {
  readonly field: ProviderSettingsFieldModel;
  readonly value: unknown;
  readonly inputId: string;
  readonly descriptionId: string | undefined;
  readonly onChange: ProviderSettingsFormProps["onChange"];
}) {
  const [rejected, setRejected] = useState<string | null>(null);
  return (
    <div className="flex w-full min-w-0 flex-col gap-1 @min-[32rem]/settings-row:w-56">
      <DraftInput
        id={inputId}
        aria-describedby={descriptionId}
        size="sm"
        className="w-full max-w-full"
        type={field.control === "password" ? "password" : undefined}
        autoComplete={field.control === "password" ? "off" : undefined}
        value={rejected ?? readProviderConfigString(value, field.key)}
        placeholder={field.placeholder}
        onCommit={(next) => {
          const clears = field.clearWhenEmpty === "omit" && next.trim().length === 0;
          if (!clears && field.accepts?.(next) === false) {
            setRejected(next);
            return;
          }
          setRejected(null);
          onChange(nextProviderConfigWithFieldValue(value, field, next));
        }}
        aria-invalid={rejected !== null || undefined}
        spellCheck={false}
      />
      {rejected !== null ? (
        <p className="text-2xs text-destructive">
          <T>Enter a valid value. It was not saved.</T>
        </p>
      ) : null}
    </div>
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
  const gt = useGT();
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
              aria-label={gt("Clear {field}", { field: field.label })}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      ) : (
        <ProviderSettingsTextInput
          field={field}
          value={value}
          inputId={inputId}
          descriptionId={descriptionId}
          onChange={onChange}
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
  const resolve = useMessages();
  const fields = deriveProviderSettingsFields(definition, value, resolve);
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
