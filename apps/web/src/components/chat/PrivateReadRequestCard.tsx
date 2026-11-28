import { useAtomValue } from "@effect/atom-react";
import {
  secretRequestAnswerInput,
  secretRequestFailureMessage,
  secretRequestPrivacyNote,
  vaultServiceReadLabel,
  type SecretRequestItem,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  VAULT_SERVICE_LABELS,
  vaultMentionLabel,
  type EnvironmentId,
  type GmailMessageSummary,
  type TaggedVaultEntry,
  type VaultServiceItem,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { T, useGT, useMessages } from "gt-react";
import { useRef, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { GmailVaultDialog } from "../settings/GmailVaultDialog";
import { privateVaultRoute, usePrivateVaultRoute } from "../settings/privateVaultRoute";
import { VaultPinField } from "../settings/VaultPinDialog";
import { Button } from "../ui/button";
import { useVaultApprovalToast } from "./useVaultApprovalToast";

interface PrivateReadCardProps {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
  readonly tag: Exclude<TaggedVaultEntry, { readonly field: string }>;
}

type ReplyView =
  | { kind: "idle" | "sending" | "done" | "declined" }
  | { kind: "error"; message: string }
  | { kind: "messages"; rows: ReadonlyArray<GmailMessageSummary & { readonly key: string }> }
  | { kind: "items"; rows: ReadonlyArray<VaultServiceItem & { readonly key: string }> };

type PrivateReadApproval = { readonly account: string; readonly pin: string };

function keyedRows<T extends GmailMessageSummary | VaultServiceItem>(rows: ReadonlyArray<T>) {
  const occurrences = new Map<string, number>();
  return rows.map((row) => {
    const content = JSON.stringify(row);
    const occurrence = occurrences.get(content) ?? 0;
    occurrences.set(content, occurrence + 1);
    return { ...row, key: `${content}:${occurrence}` };
  });
}

// Plain text only. Keep neither extra response properties nor invisible formatting controls.
function privateItems(items: ReadonlyArray<VaultServiceItem>, limit: number) {
  const text = (value: string, max: number) =>
    value
      .slice(0, max)
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
      .trim();
  return items.slice(0, limit).flatMap((item) => {
    const label = text(item.label, 256);
    const detail = item.detail && text(item.detail, 512);
    return label ? [{ label, ...(detail ? { detail } : {}) }] : [];
  });
}

export function PrivateReadRequestCard(
  props: PrivateReadCardProps & { readonly pending: boolean },
) {
  const { environmentId } = props;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const settings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const providers = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const manage = useAtomValue(serverEnvironment.manageLocalVault.permissionAtom(environmentId));
  const canUseVault = settings && providers && manage;
  const route = usePrivateVaultRoute(environmentId);
  // Destroy any private result or typed PIN if this session loses its route or authority.
  return (
    <PrivateReadCard
      key={JSON.stringify([canOperate, canUseVault, route?.origin.href])}
      {...props}
      canOperate={canOperate}
      canUseVault={canUseVault}
      privateRoute={!!route}
    />
  );
}

function PrivateReadCard({
  environmentId,
  item,
  tag,
  pending,
  canOperate,
  canUseVault,
  privateRoute,
}: PrivateReadCardProps & {
  readonly pending: boolean;
  readonly canOperate: boolean;
  readonly canUseVault: boolean;
  readonly privateRoute: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [view, setView] = useState<ReplyView>({ kind: "idle" });
  const inFlight = useRef(false);
  useVaultApprovalToast(environmentId, item.threadId, item.id, pending);
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    reportFailure: false,
    reportDefect: false,
  });
  const send = async (read?: PrivateReadApproval) => {
    if (
      !pending ||
      !canOperate ||
      inFlight.current ||
      (read && (!canUseVault || !privateRoute || !privateVaultRoute(environmentId)))
    )
      return;
    const approval = read && Redacted.make(read.pin);
    const input = secretRequestAnswerInput(
      item,
      read && approval
        ? { type: "vault_display", pin: approval, account: read.account }
        : { type: "decline" },
    );
    if (!input) {
      if (approval) Redacted.wipeUnsafe(approval);
      return;
    }
    inFlight.current = true;
    setView({ kind: "sending" });
    const result = await answer({ environmentId, input }).finally(() => {
      if (approval) Redacted.wipeUnsafe(approval);
      inFlight.current = false;
    });
    if (result._tag === "Success") {
      if (!approval) setView({ kind: "declined" });
      else if ("gmail" in tag && result.value && "messages" in result.value)
        setView({
          kind: "messages",
          rows: keyedRows(result.value.messages.slice(0, tag.gmail.limit)),
        });
      else if ("serviceRead" in tag && result.value && "items" in result.value)
        setView({
          kind: "items",
          rows: keyedRows(privateItems(result.value.items, tag.serviceRead.limit)),
        });
      else setView({ kind: "error", message: gt("The environment returned no private list.") });
    } else if (isAtomCommandInterrupted(result)) setView({ kind: "idle" });
    else
      setView({
        kind: "error",
        message: secretRequestFailureMessage(squashAtomCommandFailure(result), messages),
      });
  };
  const showForm =
    pending && (view.kind === "idle" || view.kind === "sending" || view.kind === "error");
  return (
    <div
      data-v2-item-type={item.type}
      className="grid min-w-0 gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <p className="text-sm font-medium wrap-anywhere">
        {"gmail" in tag
          ? gt(
              "{account} · {folder} · {count, plural, one {latest message} other {latest {count} messages}}",
              {
                account: item.label,
                folder: tag.gmail.folder === "spam" ? gt("Spam") : gt("Inbox"),
                count: tag.gmail.limit,
              },
            )
          : `${item.label} · ${vaultServiceReadLabel(tag.serviceRead, messages)}`}
      </p>
      {showForm ? (
        <PrivateReadApprovalForm
          key={`${environmentId}:${item.id}:${tag.name}`}
          environmentId={environmentId}
          item={item}
          tag={tag}
          canOperate={canOperate}
          canUseVault={canUseVault}
          privateRoute={privateRoute}
          busy={view.kind === "sending"}
          onAnswer={send}
        />
      ) : (view.kind === "messages" || view.kind === "items") &&
        canOperate &&
        canUseVault &&
        privateRoute ? (
        <>
          {view.rows.length ? (
            <ol className="grid min-w-0 gap-3 text-sm wrap-anywhere">
              {view.kind === "messages"
                ? view.rows.map((message) => (
                    <li key={message.key} className="grid gap-1 border-t border-border/60 pt-2">
                      <strong>{message.subject || gt("(No subject)")}</strong>
                      <span className="text-xs text-muted-foreground">
                        {message.from} · {message.date}
                      </span>
                      <p>{message.snippet}</p>
                    </li>
                  ))
                : view.rows.map((row) => (
                    <li key={row.key} className="grid gap-1 border-t border-border/60 pt-2">
                      <strong>{row.label}</strong>
                      {row.detail ? <span>{row.detail}</span> : null}
                    </li>
                  ))}
            </ol>
          ) : (
            <p className="text-sm">
              {view.kind === "messages" ? gt("No messages found.") : gt("No items found.")}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            className="justify-self-start"
            onClick={() => setView({ kind: "done" })}
          >
            <T>Hide private list</T>
          </Button>
        </>
      ) : !pending && view.kind === "sending" ? (
        <p role="status" className="text-sm">
          <T>Waiting for private results…</T>
        </p>
      ) : view.kind === "declined" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {gt("Declined")}
        </p>
      ) : !pending && view.kind !== "error" ? (
        <p className="text-sm text-muted-foreground">{gt("Private read approved")}</p>
      ) : null}
      {view.kind === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {view.message}
        </p>
      ) : null}
    </div>
  );
}

function PrivateReadApprovalForm({
  environmentId,
  item,
  tag,
  canOperate,
  canUseVault,
  privateRoute,
  busy,
  onAnswer,
}: PrivateReadCardProps & {
  readonly canOperate: boolean;
  readonly canUseVault: boolean;
  readonly privateRoute: boolean;
  readonly busy: boolean;
  readonly onAnswer: (approval?: PrivateReadApproval) => Promise<void>;
}) {
  const gt = useGT();
  const messages = useMessages();
  const vaultAvailable = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) =>
      config?.localSecretStorage === "linux-keyring-aes256gcm" &&
      config.localVaultEntries === true &&
      config.vaultPinSecurity === true,
  );
  const lookup = vaultAvailable && canUseVault && canOperate && privateRoute;
  const vault = useEnvironmentQuery(
    lookup ? serverEnvironment.localVault({ environmentId, input: {} }) : null,
  );
  const entry =
    lookup && !vault.error && !vault.data?.error
      ? vault.data?.entries?.find(
          (candidate) =>
            candidate.name === tag.name && vaultMentionLabel(candidate.title) === item.label,
        )
      : undefined;
  const [connecting, setConnecting] = useState(false);
  const gmail = "gmail" in tag;
  const supported = gmail
    ? vault.data?.gmailAvailable === true && vault.data.gmailUserCredentials === true
    : vault.data?.credentialServices?.includes(tag.serviceRead.service) === true;
  const staleConnection =
    !gmail &&
    entry?.kind === "service" &&
    entry.serviceConnection?.service === tag.serviceRead.service &&
    (!tag.revision || tag.revision !== entry.serviceConnection.revision);
  const account =
    !supported || staleConnection
      ? undefined
      : gmail
        ? entry?.gmailClient && entry.gmailAccount
        : entry?.kind === "service" && entry.serviceConnection?.service === tag.serviceRead.service
          ? entry.serviceConnection.account
          : undefined;
  const allowed = lookup && vault.data?.security?.configured === true && !busy;
  const canConnect =
    gmail && !account && allowed && supported && !!entry && entry.kind !== "service";
  const canDecline = canOperate && !busy;
  return (
    <>
      <div className="grid gap-3">
        {account ? (
          <p className="text-xs wrap-anywhere">
            {gmail
              ? gt("{service} account: {account}", { service: VAULT_SERVICE_LABELS.gmail, account })
              : gt("Connection: {account}", { account })}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">{secretRequestPrivacyNote(item, messages)}</p>
        {!canOperate || !canUseVault ? (
          <p className="text-sm text-muted-foreground">
            {gt("This session cannot approve this read. Use a session with vault access.")}
          </p>
        ) : !privateRoute ? (
          <p className="text-sm text-muted-foreground">
            {gt("Use HTTPS or the local host desktop before entering credentials or a vault PIN.")}
          </p>
        ) : lookup && vault.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            {gt("Loading entries…")}
          </p>
        ) : !account || !vault.data?.security?.configured ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {canConnect
              ? gt("Connect the selected vault entry to Gmail before approving this read.")
              : staleConnection
                ? gt(
                    "This approval no longer matches the saved connection. Decline it and request a new read from an updated host.",
                  )
                : gt("The selected credential is unavailable for this private read.")}
          </p>
        ) : null}
        {account && lookup && !vault.isPending && vault.data?.security?.configured ? (
          <PrivateReadDecision
            key={account}
            submitLabel={gmail ? gt("Show messages privately") : gt("Show items privately")}
            account={account}
            allowed={allowed}
            canDecline={canDecline}
            onAnswer={onAnswer}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            {canConnect && !vault.isPending ? (
              <Button type="button" onClick={() => setConnecting(true)}>
                <T>Set up connection</T>
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              disabled={!canDecline}
              onClick={() => void onAnswer()}
            >
              <T>Decline</T>
            </Button>
          </div>
        )}
      </div>
      {connecting && canConnect && entry ? (
        <GmailVaultDialog
          target={{
            environmentId,
            name: entry.name,
            title: entry.title,
            gmailClient: entry.gmailClient,
            gmailRedirectUri: vault.data?.gmailRedirectUri,
          }}
          onConfigured={vault.refresh}
          onClose={() => setConnecting(false)}
          onConnected={() => {
            setConnecting(false);
            vault.refresh();
          }}
        />
      ) : null}
    </>
  );
}

function PrivateReadDecision({
  account,
  submitLabel,
  allowed,
  canDecline,
  onAnswer,
}: {
  readonly account: string;
  readonly submitLabel: string;
  readonly allowed: boolean;
  readonly canDecline: boolean;
  readonly onAnswer: (approval?: PrivateReadApproval) => Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const canRead = allowed && /^[0-9]{6,8}$/.test(pin);
  return (
    <form
      className="grid gap-3"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canRead) return;
        setPin("");
        void onAnswer({ account, pin });
      }}
    >
      <VaultPinField value={pin} onChange={setPin} disabled={!allowed} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!canRead}>
          {submitLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!canDecline}
          onClick={() => {
            setPin("");
            void onAnswer();
          }}
        >
          <T>Decline</T>
        </Button>
      </div>
    </form>
  );
}
