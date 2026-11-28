import type {
  EnvironmentId,
  LocalVaultInput,
  LocalVaultEntry,
  VaultAccessMode,
  VaultTokenService,
} from "@t3tools/contracts";
import { localVaultReference, VAULT_SERVICE_LABELS } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Redacted from "effect/Redacted";
import { useState } from "react";
import { useGT } from "gt-react";
import { PlusIcon, LockKeyholeIcon, SearchIcon } from "lucide-react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { SettingsSection, SettingsRow } from "./settingsLayout";
import { VaultPinField, VaultPinSetupDialog, VaultPinConfirmDialog } from "./VaultPinDialog";
import { GmailVaultDialog } from "./GmailVaultDialog";
import { privateVaultRoute, usePrivateVaultRoute } from "./privateVaultRoute";
import {
  credentialIcon,
  VaultCredentialPicker,
  type GenericCredentialKind,
} from "./VaultCredentialPicker";
import { VaultServiceDialog } from "./VaultServiceDialog";
import { useSearchableSetting } from "./settingsSearch";

function newEntryName() {
  return `entry-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export function LocalVaultSettings({
  environmentId,
  encrypted,
  legacy,
  supported = true,
}: {
  readonly environmentId: EnvironmentId;
  readonly encrypted: boolean;
  readonly legacy: boolean;
  readonly supported?: boolean;
}) {
  const gt = useGT();
  const setting = useSearchableSetting();
  const command = useAtomCommand(serverEnvironment.manageLocalVault, {
    reportFailure: false,
    reportDefect: false,
  });
  const permission = useAtomValue(serverEnvironment.manageLocalVault.permissionAtom(environmentId));
  const privateRoute = usePrivateVaultRoute(environmentId);
  const canManage = encrypted && permission && supported && !!privateRoute;
  const query = useEnvironmentQuery(
    canManage ? serverEnvironment.localVault({ environmentId, input: {} }) : null,
  );
  const entries =
    query.data?.entries ??
    (query.data?.names ?? []).map((name): LocalVaultEntry => ({
      name,
      title: name,
      kind: "token",
      fields: ["token"],
    }));
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<{
    kind: GenericCredentialKind;
    entry: LocalVaultEntry | null;
  } | null>(null);
  const [tokenTarget, setTokenTarget] = useState<{
    environmentId: EnvironmentId;
    name: string;
    title: string;
    service: VaultTokenService;
    account?: string;
  } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{
    environmentId: EnvironmentId;
    name: string;
  } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [showPinSetup, setShowPinSetup] = useState(false);
  const [connecting, setConnecting] = useState<{
    environmentId: EnvironmentId;
    name: string;
    title?: string;
    gmailClient?: LocalVaultEntry["gmailClient"];
    edit?: boolean;
  } | null>(null);
  const [disconnecting, setDisconnecting] = useState<{
    environmentId: EnvironmentId;
    name: string;
    account: string;
  } | null>(null);
  const gmailAvailable =
    encrypted && permission && supported ? query.data?.gmailAvailable : undefined;
  const services =
    query.data?.credentialServices ??
    (gmailAvailable === true && query.data?.gmailUserCredentials === true
      ? (["gmail"] as const)
      : []);
  const gmailSupported = services.some((service) => service === "gmail");
  const pinConfigured = query.data?.security?.configured === true;
  const canEdit = canManage && pinConfigured;
  const shown = entries
    .toSorted((a, b) => a.title.localeCompare(b.title))
    .filter((entry) =>
      `${entry.title} ${entry.name} ${entry.origin ?? ""} ${entry.gmailAccount ?? ""} ${entry.serviceConnection?.account ?? ""} ${entry.serviceConnection?.service ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    );
  const failure = error ?? query.error ?? query.data?.error;
  const run = async (input: LocalVaultInput): Promise<string | null> => {
    if (!canManage || !privateVaultRoute(environmentId))
      return gt("Use a private connection to manage vault credentials.");
    const result = await command({ environmentId, input });
    const message =
      result._tag !== "Success" ? gt("Could not reach the vault. Try again.") : result.value.error;
    setError(message);
    query.refresh();
    return message;
  };
  return (
    <SettingsSection
      {...setting("local-vault")}
      headerAction={
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <LockKeyholeIcon className="size-3.5" aria-hidden />
            {encrypted ? gt("Encrypted locally") : legacy ? gt("Not encrypted") : gt("Unavailable")}
          </span>
          {encrypted && supported && permission ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={
                !canManage || busy || (!pinConfigured && !query.data?.security?.canSetInitialPin)
              }
              onClick={() => setShowPinSetup(true)}
            >
              {pinConfigured ? gt("Change PIN") : gt("Set PIN")}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={!canEdit || busy}
            onClick={() => {
              setError(null);
              setPicking(true);
            }}
          >
            <PlusIcon className="size-3" aria-hidden />
            {gt("Add credential")}
          </Button>
        </div>
      }
    >
      {failure ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-destructive"
        >
          <span>{failure}</span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setError(null);
              query.refresh();
            }}
          >
            {gt("Retry")}
          </Button>
        </div>
      ) : null}
      {encrypted && !supported ? (
        <SettingsRow
          title={gt("Update the environment to manage entries")}
          description={gt(
            "Storage is encrypted, but this environment needs the latest Hyakki backend. Fully quit and reopen it, then retry.",
          )}
        />
      ) : !encrypted ? (
        <SettingsRow
          title={gt("Encrypted storage required")}
          description={gt(
            "Connect to an environment with vault encryption enabled before saving credentials.",
          )}
        />
      ) : !permission ? (
        <SettingsRow
          title={gt("Vault access restricted")}
          description={gt(
            "Ask the environment owner for settings and provider-management permissions.",
          )}
        />
      ) : !privateRoute ? (
        <SettingsRow
          title={gt("Private connection required")}
          description={gt(
            "Use HTTPS or the local host desktop before entering credentials or a vault PIN.",
          )}
        />
      ) : query.isPending && !query.data ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">{gt("Loading entries…")}</p>
      ) : (
        <>
          {!pinConfigured ? (
            <SettingsRow
              title={gt("Set a PIN before using the vault")}
              description={gt(
                "Credentials ask for permission by default. Set the first 6–8 digit PIN from the owner's desktop.",
              )}
            />
          ) : null}
          {query.data?.security && query.data.security.retryAt > 0 ? (
            <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
              {gt("PIN cooldown until {time}", {
                time: new Date(query.data.security.retryAt).toLocaleTimeString(),
              })}
            </p>
          ) : null}
          {entries.length ? (
            <div className="flex items-center gap-2 px-4 py-3">
              <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={gt("Search saved entries")}
                aria-label={gt("Search saved entries")}
              />
            </div>
          ) : null}
          {!entries.length ? (
            <SettingsRow
              title={gt("What would you like to keep safe?")}
              description={gt(
                "Connect a service to approve private reads, or save an API token, website login, or secure note.",
              )}
            />
          ) : !shown.length ? (
            <SettingsRow
              title={gt("No matching entries")}
              description={gt("Try another name or website.")}
            />
          ) : (
            shown.map((entry) => {
              const connection = entry.serviceConnection;
              const genericKind =
                entry.kind === "gmail" || entry.kind === "service" ? null : entry.kind;
              const mixedGmail = !!entry.gmailClient || !!entry.gmailAccount;
              const gmailEntry = entry.kind === "gmail" || mixedGmail;
              const Icon = credentialIcon(
                entry.kind === "service" ? (connection?.service ?? "token") : entry.kind,
              );
              return (
                <SettingsRow
                  key={entry.name}
                  title={
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate">{entry.title}</span>
                    </span>
                  }
                  description={
                    <span>
                      {entry.kind === "login"
                        ? gt("Website login")
                        : entry.kind === "note"
                          ? gt("Secure note")
                          : entry.kind === "gmail"
                            ? VAULT_SERVICE_LABELS.gmail
                            : entry.kind === "service"
                              ? connection
                                ? VAULT_SERVICE_LABELS[connection.service]
                                : gt("Service connection")
                              : gt("API token")}
                      {entry.origin ? ` · ${entry.origin}` : ""}
                      {" · "}
                      {entry.kind === "service" || entry.kind === "gmail"
                        ? gt("PIN each use")
                        : entry.access === "allow"
                          ? gt("Protected use allowed")
                          : gt("PIN each use")}
                      {connection ? (
                        <span className="block break-all">
                          {gt("Connection: {account}", { account: connection.account })}
                        </span>
                      ) : null}
                      {genericKind && !mixedGmail ? (
                        <span className="block">{gt("Saved field · no service connected")}</span>
                      ) : null}
                      {entry.gmailAccount ? (
                        <span className="block break-all">
                          {gt("Read-only Gmail: {account} · PIN for each read", {
                            account: entry.gmailAccount,
                          })}
                        </span>
                      ) : entry.gmailClient ? (
                        <span className="block">
                          {gt("Google client saved · no mailbox connected")}
                        </span>
                      ) : null}
                    </span>
                  }
                  control={
                    <div className="flex flex-wrap justify-end gap-1">
                      {entry.kind === "token" ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={!canEdit || busy}
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(
                                localVaultReference(entry.name, "token"),
                              );
                              setCopied(entry.name);
                            } catch {
                              setError(gt("Could not copy the reference. Try again."));
                            }
                          }}
                        >
                          {copied === entry.name ? gt("Reference copied") : gt("Copy reference")}
                        </Button>
                      ) : null}
                      {gmailSupported && gmailEntry ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={!canEdit || busy}
                          aria-label={
                            entry.gmailAccount
                              ? gt("Reconnect {title}", { title: entry.title })
                              : gt("Connect {title}", { title: entry.title })
                          }
                          onClick={() =>
                            setConnecting({
                              environmentId,
                              name: entry.name,
                              title: entry.title,
                              gmailClient: entry.gmailClient,
                            })
                          }
                        >
                          {entry.gmailAccount ? gt("Reconnect") : gt("Connect")}
                        </Button>
                      ) : null}
                      {gmailSupported && entry.gmailClient ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={!canEdit || busy}
                          aria-label={gt("Edit client for {title}", { title: entry.title })}
                          onClick={() =>
                            setConnecting({
                              environmentId,
                              name: entry.name,
                              title: entry.title,
                              gmailClient: entry.gmailClient,
                              edit: true,
                            })
                          }
                        >
                          {gt("Edit client")}
                        </Button>
                      ) : null}
                      {(gmailAvailable !== undefined || gmailSupported) && entry.gmailAccount ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={!canEdit || busy}
                          aria-label={gt("Disconnect {title}", { title: entry.title })}
                          onClick={() =>
                            setDisconnecting({
                              environmentId,
                              name: entry.name,
                              account: entry.gmailAccount!,
                            })
                          }
                        >
                          {gt("Disconnect")}
                        </Button>
                      ) : null}
                      {entry.kind === "service" &&
                      connection &&
                      services.some((id) => id === connection.service) ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={!canEdit || busy}
                          aria-label={gt("Edit {title}", { title: entry.title })}
                          onClick={() => {
                            setError(null);
                            setTokenTarget({
                              environmentId,
                              name: entry.name,
                              title: entry.title,
                              ...connection,
                            });
                          }}
                        >
                          {gt("Edit")}
                        </Button>
                      ) : null}
                      {genericKind ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={!canEdit || busy}
                          aria-label={gt("Edit {title}", { title: entry.title })}
                          onClick={() => {
                            setError(null);
                            setEditing({ kind: genericKind, entry });
                          }}
                        >
                          {gt("Edit")}
                        </Button>
                      ) : null}
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={!canEdit || busy}
                        aria-label={gt("Delete {title}", { title: entry.title })}
                        onClick={() =>
                          setConfirmRemove({
                            environmentId,
                            name: entry.name,
                          })
                        }
                      >
                        {gt("Delete")}
                      </Button>
                    </div>
                  }
                />
              );
            })
          )}
        </>
      )}
      <details className="px-4 py-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer">{gt("How to use saved entries")}</summary>
        <div className="mt-2 max-w-prose space-y-2 leading-relaxed">
          <p>
            {gt(
              "API token: choose Hyakki vault in a provider's credential source, then pick a saved token. Website login: choose Use saved entry on an agent's credential request and approve the fields for that website. A secure note can be shared only when you approve a request.",
            )}
          </p>
          <p>
            {gt(
              "In chat, type @ followed by an entry name and choose the vault result. Only the name enters chat, so use a label you are comfortable sharing. A mention does not give the agent access. Keep sensitive details in the protected fields.",
            )}
          </p>
          <p>
            {gt(
              "AES-256-GCM protects stored fields using a key in the OS keyring. Hyakki does not sync this vault. Full-access agents and other programs running as your user are not isolated by this encryption. Old backups may contain unencrypted values.",
            )}
          </p>
        </div>
      </details>
      {canEdit && picking ? (
        <VaultCredentialPicker
          services={services}
          onClose={() => setPicking(false)}
          onSelect={(choice) => {
            setPicking(false);
            if (choice === "token" || choice === "login" || choice === "note")
              setEditing({ kind: choice, entry: null });
            else if (choice === "gmail") setConnecting({ environmentId, name: newEntryName() });
            else
              setTokenTarget({ environmentId, name: newEntryName(), title: "", service: choice });
          }}
        />
      ) : null}
      {canEdit &&
      tokenTarget?.environmentId === environmentId &&
      services.some((id) => id === tokenTarget.service) ? (
        <VaultServiceDialog
          key={`${environmentId}:${tokenTarget.name}`}
          environmentId={environmentId}
          name={tokenTarget.name}
          initialTitle={tokenTarget.title}
          service={tokenTarget.service}
          {...(tokenTarget.account ? { account: tokenTarget.account } : {})}
          onClose={() => setTokenTarget(null)}
          onSaved={() => {
            setTokenTarget(null);
            setError(null);
            query.refresh();
          }}
        />
      ) : null}
      {canEdit && gmailSupported && connecting?.environmentId === environmentId ? (
        <GmailVaultDialog
          key={`${environmentId}:${connecting.name}`}
          target={{ ...connecting, gmailRedirectUri: query.data?.gmailRedirectUri }}
          onConfigured={query.refresh}
          onClose={() => setConnecting(null)}
          onConnected={() => {
            setConnecting(null);
            setError(null);
            query.refresh();
          }}
        />
      ) : null}
      {canEdit && disconnecting?.environmentId === environmentId ? (
        <VaultPinConfirmDialog
          title={gt("Disconnect account")}
          description={gt("Remove the read-only connection for {account} from this vault?", {
            account: disconnecting.account,
          })}
          submitLabel={gt("Disconnect")}
          onClose={() => setDisconnecting(null)}
          onConfirm={async (pin) => {
            const secret = Redacted.make(pin);
            try {
              return await run({
                action: "gmail-disconnect",
                name: disconnecting.name,
                pin: secret,
              });
            } finally {
              Redacted.wipeUnsafe(secret);
            }
          }}
        />
      ) : null}
      {canManage && showPinSetup ? (
        <VaultPinSetupDialog
          configured={pinConfigured}
          onClose={() => setShowPinSetup(false)}
          onSave={async (pin, oldPin) => {
            const next = Redacted.make(pin),
              current = oldPin ? Redacted.make(oldPin) : undefined;
            return run({
              action: "set-pin",
              newPin: next,
              ...(current ? { pin: current } : {}),
            }).finally(() => {
              Redacted.wipeUnsafe(next);
              if (current) Redacted.wipeUnsafe(current);
            });
          }}
        />
      ) : null}
      {canEdit && confirmRemove?.environmentId === environmentId ? (
        <VaultPinConfirmDialog
          title={gt("Delete vault entry")}
          description={gt(
            "This removes the saved entry and invalidates pending vault approvals. It cannot retract credentials already delivered to an agent or provider.",
          )}
          submitLabel={gt("Delete entry")}
          onClose={() => setConfirmRemove(null)}
          onConfirm={async (pin) => {
            const secret = Redacted.make(pin);
            setBusy(true);
            return run({ action: "remove", name: confirmRemove.name, pin: secret }).finally(() => {
              Redacted.wipeUnsafe(secret);
              setBusy(false);
            });
          }}
        />
      ) : null}
      {canEdit && editing ? (
        <VaultEntryDialog
          kind={editing.kind}
          entry={editing.entry}
          onClose={() => setEditing(null)}
          onSave={async (name, value, access, pin) => {
            const secret = Redacted.make(value),
              approval = Redacted.make(pin);
            return run({
              action: "save",
              name,
              value: secret,
              replace: editing.entry !== null,
              structured: true,
              access,
              pin: approval,
            }).finally(() => {
              Redacted.wipeUnsafe(secret);
              Redacted.wipeUnsafe(approval);
            });
          }}
        />
      ) : null}
    </SettingsSection>
  );
}

function VaultEntryDialog({
  entry,
  kind,
  onClose,
  onSave,
}: {
  readonly entry: LocalVaultEntry | null;
  readonly kind: GenericCredentialKind;
  readonly onClose: () => void;
  readonly onSave: (
    name: string,
    value: string,
    access: VaultAccessMode,
    pin: string,
  ) => Promise<string | null>;
}) {
  const gt = useGT();
  const [title, setTitle] = useState(entry?.title ?? "");
  const [origin, setOrigin] = useState(entry?.origin ?? "");
  const [username, setUsername] = useState("");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [pin, setPin] = useState("");
  const [access, setAccess] = useState<VaultAccessMode>(entry?.access ?? "ask");
  const [name] = useState(() => entry?.name ?? newEntryName());
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{entry ? gt("Edit entry") : gt("Add vault entry")}</DialogTitle>
          <DialogDescription>
            {entry
              ? gt("Leave protected fields blank to keep their saved values.")
              : gt(
                  "Protected fields stay on this environment. Nothing is shared until you choose to use it.",
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="local-vault-form"
            autoComplete="off"
            className="grid gap-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (pending) return;
              setPending(true);
              setFailure(null);
              const record = {
                version: 1,
                kind,
                title: title.trim(),
                ...(kind === "login"
                  ? { origin, username, password: value }
                  : kind === "token"
                    ? { token: value }
                    : { note: value }),
              };
              const encoded = JSON.stringify(record);
              if (encoded.length > 16384) {
                setFailure(
                  gt(
                    "This entry is too large. Shorten the note or credential fields before saving.",
                  ),
                );
                setPending(false);
                return;
              }
              const approval = pin;
              setPin("");
              setValue("");
              setUsername("");
              setShow(false);
              const error = await Promise.resolve()
                .then(() => onSave(name, encoded, access, approval))
                .finally(() => setPending(false));
              if (error)
                setFailure(
                  `${error} ${gt("Protected fields were cleared. Re-enter your changes before retrying.")}`,
                );
              else onClose();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="vault-entry-title">{gt("Name")}</Label>
              <Input
                id="vault-entry-title"
                autoFocus
                value={title}
                disabled={pending}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={
                  kind === "login"
                    ? gt("GitHub work")
                    : kind === "note"
                      ? gt("Recovery instructions")
                      : gt("GitHub API")
                }
                maxLength={120}
                required
              />
            </div>
            {kind === "login" ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="vault-entry-website">{gt("Website")}</Label>
                  <Input
                    id="vault-entry-website"
                    type="url"
                    value={origin}
                    disabled={pending}
                    onChange={(e) => setOrigin(e.target.value)}
                    placeholder="https://github.com"
                    pattern="https://.*"
                    maxLength={2048}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    {gt("This login can only answer requests for this exact HTTPS website.")}
                  </p>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="vault-entry-username">{gt("Username or email")}</Label>
                  <Input
                    id="vault-entry-username"
                    value={username}
                    disabled={pending}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="off"
                    placeholder={entry ? gt("Unchanged") : "you@example.com"}
                    maxLength={512}
                    required={!entry}
                  />
                </div>
              </>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="vault-entry-value">
                {kind === "login" ? gt("Password") : kind === "note" ? gt("Note") : gt("Token")}
              </Label>
              {kind === "note" ? (
                <Textarea
                  style={{ fieldSizing: "fixed" }}
                  id="vault-entry-value"
                  value={value}
                  disabled={pending}
                  onChange={(e) => setValue(e.target.value)}
                  rows={5}
                  maxLength={12000}
                  required={!entry}
                  placeholder={
                    entry
                      ? gt("Unchanged")
                      : gt("Keep private instructions or recovery information here.")
                  }
                />
              ) : (
                <div className="flex gap-2">
                  <Input
                    id="vault-entry-value"
                    type={show ? "text" : "password"}
                    value={value}
                    disabled={pending}
                    onChange={(e) => setValue(e.target.value)}
                    autoComplete="new-password"
                    spellCheck={false}
                    maxLength={6000}
                    required={!entry}
                    placeholder={entry ? gt("Unchanged") : undefined}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending || !value}
                    aria-pressed={show}
                    onClick={() => setShow(!show)}
                  >
                    {show ? gt("Hide") : gt("Show")}
                  </Button>
                </div>
              )}
            </div>
            {kind === "login" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => {
                  const alphabet =
                    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
                  setValue(
                    Array.from(
                      crypto.getRandomValues(new Uint8Array(32)),
                      (byte) => alphabet[byte & 63],
                    ).join(""),
                  );
                  setShow(false);
                }}
              >
                {gt("Generate password")}
              </Button>
            ) : null}
            <div className="grid gap-1.5">
              <Label>{gt("Credential access")}</Label>
              <div
                className="flex flex-wrap gap-2"
                role="group"
                aria-label={gt("Credential access")}
              >
                <Button
                  type="button"
                  size="sm"
                  variant={access === "ask" ? "default" : "outline"}
                  aria-pressed={access === "ask"}
                  disabled={pending}
                  onClick={() => setAccess("ask")}
                >
                  {gt("Ask every time")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={access === "allow" ? "default" : "outline"}
                  aria-pressed={access === "allow"}
                  disabled={pending}
                  onClick={() => setAccess("allow")}
                >
                  {gt("Allow protected use")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {gt(
                  "Protected use does not return saved fields in vault responses. Command access always needs a fresh PIN. Full-access host processes are not isolated.",
                )}
              </p>
            </div>
            <VaultPinField value={pin} onChange={setPin} disabled={pending} />
            {failure ? (
              <p role="alert" className="text-sm text-destructive">
                {failure}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {gt("Cancel")}
          </Button>
          <Button
            form="local-vault-form"
            type="submit"
            disabled={
              pending ||
              pin.length < 6 ||
              !title.trim() ||
              (!entry && (!value || (kind === "login" && !username)))
            }
          >
            {pending ? gt("Saving…") : entry ? gt("Save changes") : gt("Save entry")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
