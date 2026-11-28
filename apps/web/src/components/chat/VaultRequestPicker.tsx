import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type LocalVaultEntry,
  type LocalVaultField,
} from "@t3tools/contracts";
import {
  secretRequestFailureMessage,
  secretRequestPrivacyNote,
  type SecretRequestItem,
} from "@t3tools/client-runtime/secret-request";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import * as Redacted from "effect/Redacted";
import { VaultPinField } from "../settings/VaultPinDialog";
import { Checkbox } from "../ui/checkbox";
import { useGT, useMessages } from "gt-react";
import { LockKeyholeIcon, RefreshCwIcon } from "lucide-react";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

function vaultRequestEntryAllowed(entry: LocalVaultEntry, target: string | undefined): boolean {
  if (entry.kind !== "login") return true;
  try {
    const url = new URL(target ?? "");
    return (
      url.protocol === "https:" && !url.username && !url.password && url.origin === entry.origin
    );
  } catch {
    return false;
  }
}
function suggestField(
  entry: LocalVaultEntry | undefined,
  key: string,
  multiple: boolean,
): LocalVaultField | undefined {
  if (!entry) return undefined;
  if (entry.fields.length === 1) return entry.fields[0];
  if (/pass/i.test(key)) return "password";
  if (/user|email|login/i.test(key)) return "username";
  if (!multiple) return "password";
  return undefined;
}
export function VaultRequestPicker({
  environmentId,
  item,
  onBack,
}: {
  readonly environmentId: EnvironmentId;
  readonly item: Pick<
    SecretRequestItem,
    "id" | "threadId" | "label" | "reason" | "url" | "fields" | "delivery"
  >;
  readonly onBack: () => void;
}) {
  const gt = useGT(),
    messages = useMessages(),
    id = useId();
  const settings = useEnvironmentScope(environmentId, AuthSettingsWriteScope),
    providers = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const query = useEnvironmentQuery(
    settings && providers ? serverEnvironment.localVault({ environmentId, input: {} }) : null,
  );
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    reportFailure: false,
    reportDefect: false,
  });
  const [selected, setSelected] = useState<string | null>(null),
    [chosen, setChosen] = useState<Readonly<Record<string, LocalVaultField>>>({}),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [disclose, setDisclose] = useState(false);
  const entries = query.data?.entries?.filter((entry) => entry.fields.length > 0) ?? [];
  const entry = entries.find((entry) => entry.name === selected);
  const inputs = item.fields?.map((field) => ({ key: field.name, label: field.label })) ?? [
    { key: "value", label: item.label },
  ];
  const fields = Object.fromEntries(
    inputs.map((input) => [
      input.key,
      Object.hasOwn(chosen, input.key)
        ? chosen[input.key]
        : suggestField(entry, input.key, item.fields !== undefined),
    ]),
  );
  const allowed = entry !== undefined && vaultRequestEntryAllowed(entry, item.url);
  const requiresPin = entry !== undefined && (entry.access !== "allow" || item.delivery === "file");
  const valid =
    settings &&
    providers &&
    allowed &&
    query.data?.security?.configured === true &&
    inputs.every((input) => fields[input.key] !== undefined) &&
    (!requiresPin || /^[0-9]{6,8}$/.test(pin)) &&
    (item.delivery !== "file" || disclose);
  const fieldLabel = (field: LocalVaultField) =>
    field === "username"
      ? gt("Username or email")
      : field === "password"
        ? gt("Password")
        : field === "note"
          ? gt("Note")
          : gt("Token");
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4">
      <div>
        <p className="text-sm font-medium">{item.label}</p>
        {item.reason.trim() ? (
          <p className="mt-1 text-sm text-muted-foreground">{item.reason}</p>
        ) : null}
        {item.url ? (
          <p className="mt-1 break-all text-xs text-muted-foreground">{item.url}</p>
        ) : null}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-entry`}>{gt("Saved entry")}</Label>
        <div className="flex min-w-0 items-center gap-1.5">
          <Select
            value={selected}
            disabled={pending || !settings || !providers}
            onValueChange={(value) => {
              setSelected(value);
              setChosen({});
              setError(null);
              setPin("");
              setDisclose(false);
            }}
          >
            <SelectTrigger id={`${id}-entry`} className="min-w-0 flex-1">
              <SelectValue placeholder={gt("Choose an entry")}>{entry?.title}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {entries.map((entry) => (
                <SelectItem
                  key={entry.name}
                  value={entry.name}
                  disabled={!vaultRequestEntryAllowed(entry, item.url)}
                >
                  {entry.title}
                  {!vaultRequestEntryAllowed(entry, item.url)
                    ? ` · ${gt("Different website")}`
                    : ""}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={gt("Refresh vault entries")}
            disabled={pending || query.isPending || !settings || !providers}
            onClick={() => query.refresh()}
          >
            <RefreshCwIcon aria-hidden />
          </Button>
        </div>
      </div>
      {entry
        ? inputs.map((input, index) => (
            <div className="grid gap-1.5" key={input.key}>
              <Label htmlFor={`${id}-field-${index}`}>
                {gt("Use for {field}", { field: input.label })}
              </Label>
              <Select
                value={fields[input.key] ?? null}
                disabled={pending}
                onValueChange={(field) => {
                  if (field) setChosen({ ...chosen, [input.key]: field as LocalVaultField });
                }}
              >
                <SelectTrigger id={`${id}-field-${index}`}>
                  <SelectValue placeholder={gt("Choose a saved field")}>
                    {fields[input.key] ? fieldLabel(fields[input.key]!) : undefined}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {entry.fields.map((field) => (
                    <SelectItem key={field} value={field}>
                      {fieldLabel(field)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ))
        : null}
      {!settings || !providers ? (
        <p className="text-xs text-muted-foreground">
          {gt("You need settings and provider permissions to use saved entries.")}
        </p>
      ) : query.isPending && !query.data ? (
        <p className="text-xs text-muted-foreground">{gt("Loading entries…")}</p>
      ) : !entries.length ? (
        <p className="text-xs text-muted-foreground">
          {gt("Add a token, website login, or note in Settings → Secrets first.")}{" "}
          <Link to="/settings/secrets" className="underline underline-offset-2">
            {gt("Manage vault")}
          </Link>
        </p>
      ) : null}
      {entries.some(
        (entry) => entry.kind === "login" && !vaultRequestEntryAllowed(entry, item.url),
      ) ? (
        <p className="text-xs text-muted-foreground">
          {gt(
            "Logins for other websites are disabled. A login requires a request with its exact saved HTTPS website.",
          )}
        </p>
      ) : null}
      {query.data?.security?.configured !== true && settings && providers ? (
        <p className="text-xs text-muted-foreground">
          {gt("Set a vault PIN in Settings → Secrets before approving saved fields.")}
        </p>
      ) : null}
      {requiresPin ? <VaultPinField value={pin} onChange={setPin} disabled={pending} /> : null}
      {entry && item.delivery === "file" ? (
        <div className="flex items-start gap-2">
          <Checkbox
            id={`${id}-disclose`}
            checked={disclose}
            disabled={pending}
            onCheckedChange={(checked) => setDisclose(checked === true)}
          />
          <Label htmlFor={`${id}-disclose`}>
            {gt("Allow this agent's commands to read the real selected fields for this request.")}
          </Label>
        </div>
      ) : null}
      {error || query.error || query.data?.error ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? query.error ?? query.data?.error}
        </p>
      ) : null}
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <LockKeyholeIcon className="size-3.5 shrink-0" aria-hidden />
        {secretRequestPrivacyNote(item, messages)}
      </p>
      {entry?.kind === "login" && item.delivery === "file" ? (
        <p className="text-xs text-muted-foreground">
          {gt(
            "Command access is not a browser sandbox. After approval, the agent's commands can read these fields and are not restricted to the saved website.",
          )}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onBack}>
          {gt("Back")}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!valid || pending}
          onClick={async () => {
            if (!entry || !valid || pending) return;
            setPending(true);
            setError(null);
            const approval = requiresPin ? Redacted.make(pin) : undefined;
            setPin("");
            await (async () => {
              const result = await answer({
                environmentId,
                input: {
                  threadId: item.threadId,
                  turnItemId: item.id,
                  answer: {
                    type: "vault",
                    name: entry.name,
                    fields: fields as Readonly<Record<string, LocalVaultField>>,
                    ...(approval ? { pin: approval } : {}),
                    ...(item.delivery === "file" ? { discloseToCommands: disclose } : {}),
                  },
                },
              });
              if (result._tag !== "Success") {
                setError(secretRequestFailureMessage(squashAtomCommandFailure(result), messages));
                query.refresh();
              }
            })().finally(() => {
              if (approval) Redacted.wipeUnsafe(approval);
              setPending(false);
            });
          }}
        >
          {pending
            ? gt("Approving…")
            : item.delivery === "file"
              ? gt("Approve command access")
              : gt("Approve for this request")}
        </Button>
      </div>
    </div>
  );
}
