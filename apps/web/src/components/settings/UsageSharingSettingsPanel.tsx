import type {
  EnvironmentId,
  UsageShareGrant,
  UsageShareLimits,
  UsageSharePeriod,
  UsageShareSourceKind,
  UsageSharingOverview,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CopyIcon, KeyRoundIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { usageSharingEnvironment } from "../../state/usageSharing";
import { useAtomCommand } from "../../state/use-atom-command";
import { RedeemShareCode } from "../usageSharing/RedeemShareCode";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const SOURCE_LABELS: Record<UsageShareSourceKind, string> = {
  "anthropic-api": "Claude (Anthropic API key)",
  "openai-api": "OpenAI (API key)",
  "openrouter-api": "OpenRouter (API key)",
  ollama: "Local models (Ollama)",
};

const MODEL_HINTS: Record<UsageShareSourceKind, string> = {
  "anthropic-api": "claude-sonnet-5-5, claude-haiku-5-5",
  "openai-api": "gpt-6.1-sol, gpt-6-luna",
  "openrouter-api": "anthropic/claude-sonnet-5.5",
  ollama: "continuum/qwen3-8b",
};

const PERIOD_LABELS: Record<UsageSharePeriod, string> = {
  day: "per day",
  week: "per week",
  month: "per month",
  total: "in total",
};

const STATUS_BADGE: Record<
  UsageShareGrant["status"],
  { label: string; variant: "success" | "warning" | "secondary" | "error" }
> = {
  active: { label: "Active", variant: "success" },
  paused: { label: "Paused", variant: "secondary" },
  "limit-reached": { label: "Limit reached", variant: "warning" },
  expired: { label: "Expired", variant: "secondary" },
  revoked: { label: "Revoked", variant: "error" },
};

type CommandResult =
  | { readonly _tag: "Success" }
  | ({ readonly _tag: "Failure" } & Parameters<typeof squashAtomCommandFailure>[0]);

const failureText = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error && cause.message ? cause.message : "That did not work.";
};

const numberOrNull = (text: string) => {
  const value = Number(text.replace(/[,_\s]/g, ""));
  return text.trim() === "" || !Number.isFinite(value) || value <= 0 ? null : Math.round(value);
};

const describeLimits = (limits: UsageShareLimits) => {
  const parts = [
    limits.maxRequests === null ? null : `${limits.maxRequests.toLocaleString()} requests`,
    limits.maxTokens === null ? null : `${limits.maxTokens.toLocaleString()} tokens`,
  ].filter(Boolean);
  return parts.length === 0
    ? `No budget · ${limits.maxConcurrent} at a time`
    : `${parts.join(" or ")} ${PERIOD_LABELS[limits.period]} · ${limits.maxConcurrent} at a time`;
};

/** Settings → Usage sharing: share access you may share, and redeem codes others send you. */
export function UsageSharingSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return null;
  return <UsageSharingContent environmentId={environmentId} />;
}

function UsageSharingContent({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const searchableSetting = useSearchableSetting();
  const query = useEnvironmentQuery(usageSharingEnvironment.overview({ environmentId, input: {} }));
  const overview = query.data;
  const [error, setError] = useState<string | null>(null);
  const [newCode, setNewCode] = useState<{ label: string; code: string } | null>(null);
  if (overview === null) return null;

  const report = (result: CommandResult) => {
    if (result._tag === "Success") setError(null);
    else setError(failureText(result));
    query.refresh();
  };

  return (
    <SettingsPageContainer>
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <SettingsSection id="usage-sharing-redeem" title="Use a sharing code">
        <SettingsRow
          {...searchableSetting("setting-usage-sharing-redeem")}
          title="Redeem a code"
          description="Someone shared AI access with you? Paste their code. You do not need an AI account of your own."
          control={
            <div className="w-full sm:w-96">
              <RedeemShareCode environmentId={environmentId} onRedeemed={() => query.refresh()} />
            </div>
          }
        />
        {overview.connections.map((connection) => (
          <ConnectionRow
            key={connection.id}
            environmentId={environmentId}
            connection={connection}
            onDone={report}
          />
        ))}
      </SettingsSection>

      <SettingsSection id="usage-sharing-owner" title="Share your AI access">
        <div className="space-y-2 px-4 py-3 text-xs text-muted-foreground sm:px-5">
          <p>
            Share access you are allowed to share: your own API keys (billed to you) or the models
            running on this computer. The person you share with runs their own agent, in their own
            projects; their model requests come to this computer, which adds your key and forwards
            them. Your keys, sign-ins, conversations, projects, and memory vaults never leave this
            computer.
          </p>
          <p>
            <span className="font-medium text-foreground">Privacy:</span> this computer sees the
            requests it forwards, including the prompts and code your recipient's agent sends, and
            so does the AI provider. Only share with people you trust.
          </p>
          <SubscriptionSharingNote />
        </div>
        <EndpointRow environmentId={environmentId} overview={overview} onDone={report} />
        {overview.sources.map((source) => (
          <SourceRow
            key={source.kind}
            environmentId={environmentId}
            source={source}
            onDone={report}
          />
        ))}
      </SettingsSection>

      <SettingsSection id="usage-sharing-codes" title="Sharing codes">
        {newCode ? (
          <NewCodeNotice
            label={newCode.label}
            code={newCode.code}
            onDismiss={() => setNewCode(null)}
          />
        ) : null}
        <CreateGrantForm
          environmentId={environmentId}
          overview={overview}
          onCreated={(label, code) => {
            setNewCode({ label, code });
            query.refresh();
          }}
          onError={setError}
        />
        {overview.grants.length === 0 ? (
          <SettingsRow
            title="No sharing codes yet"
            description="Codes you create appear here, with their usage."
          />
        ) : (
          overview.grants.map((grant) => (
            <GrantRow
              key={grant.id}
              environmentId={environmentId}
              grant={grant}
              onDone={report}
              onNewCode={(code) => setNewCode({ label: grant.label, code })}
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

/** What each provider officially allows for sharing a subscription. */
function SubscriptionSharingNote() {
  return (
    <details className="rounded-md border border-border/70 p-2" data-subscription-sharing-note>
      <summary className="cursor-pointer font-medium text-foreground">
        Sharing a Claude, ChatGPT, or Google AI subscription
      </summary>
      <div className="mt-2 space-y-1.5">
        <p>
          Subscriptions cannot be relayed. Anthropic does not allow apps to route other people's
          requests through Claude Free, Pro, Max, or Ultra sign-ins, and OpenAI's terms forbid
          making a ChatGPT account available to anyone else. Continuum will not work around that.
          Each provider offers its own way to share instead; the person then signs in to Continuum
          with their own account:
        </p>
        <ul className="list-disc space-y-1 ps-4">
          <li>
            <span className="text-foreground">Google AI Plus, Pro, or Ultra:</span> family sharing
            for up to 5 people includes Antigravity. Usage comes from one shared family pool. Set it
            up at one.google.com/family.
          </li>
          <li>
            <span className="text-foreground">ChatGPT / Codex:</span> invite them to a ChatGPT
            Business workspace (Workspace settings → Members), where you can set a monthly spending
            limit per member.
          </li>
          <li>
            <span className="text-foreground">Claude:</span> add them as a member of a Claude Team
            or Enterprise plan, or share an Anthropic API key here instead.
          </li>
        </ul>
      </div>
    </details>
  );
}

function EndpointRow({
  environmentId,
  overview,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly overview: UsageSharingOverview;
  readonly onDone: (result: CommandResult) => void;
}) {
  const searchableSetting = useSearchableSetting();
  const setEndpoint = useAtomCommand(usageSharingEnvironment.setEndpoint, { reportFailure: false });
  const [value, setValue] = useState(overview.endpoint ?? "");
  return (
    <SettingsRow
      {...searchableSetting("setting-usage-sharing-endpoint")}
      title="Address recipients reach this computer at"
      description="Recipients must be able to reach this server, for example over Tailscale (http://100.x.y.z:port) or your local network. Codes include this address."
      control={
        <form
          className="flex w-full items-center gap-2 sm:w-96"
          onSubmit={(event) => {
            event.preventDefault();
            void setEndpoint({ environmentId, input: { endpoint: value.trim() || null } }).then(
              onDone,
            );
          }}
        >
          <Input
            aria-label="Sharing address"
            placeholder="http://100.64.0.2:3773"
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
          <Button type="submit" size="sm" variant="outline">
            Save
          </Button>
        </form>
      }
    />
  );
}

function SourceRow({
  environmentId,
  source,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly source: UsageSharingOverview["sources"][number];
  readonly onDone: (result: CommandResult) => void;
}) {
  const setSource = useAtomCommand(usageSharingEnvironment.setSource, { reportFailure: false });
  const [key, setKey] = useState("");
  if (source.kind === "ollama") {
    return (
      <SettingsRow
        title={SOURCE_LABELS.ollama}
        description="Shares models you downloaded in Settings → Local models. No key needed."
        control={<Badge variant="secondary">Available</Badge>}
      />
    );
  }
  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <KeyRoundIcon className="size-3.5" />
          {SOURCE_LABELS[source.kind]}
          {source.configured ? <Badge variant="success">Key saved</Badge> : null}
        </span>
      }
      description="Your own API key, stored in this computer's secret store and never sent to recipients. Usage is billed to you."
      control={
        <form
          className="flex w-full items-center gap-2 sm:w-96"
          onSubmit={(event) => {
            event.preventDefault();
            void setSource({ environmentId, input: { kind: source.kind, apiKey: key } }).then(
              (result) => {
                setKey("");
                onDone(result);
              },
            );
          }}
        >
          <Input
            aria-label={`${SOURCE_LABELS[source.kind]} key`}
            type="password"
            autoComplete="off"
            placeholder={source.configured ? "Replace key" : "Paste your API key"}
            value={key}
            onChange={(event) => setKey(event.currentTarget.value)}
          />
          <Button type="submit" size="sm" variant="outline" disabled={key.trim() === ""}>
            Save
          </Button>
          {source.configured ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                void setSource({ environmentId, input: { kind: source.kind, apiKey: null } }).then(
                  onDone,
                )
              }
            >
              Remove
            </Button>
          ) : null}
        </form>
      }
    />
  );
}

function CreateGrantForm({
  environmentId,
  overview,
  onCreated,
  onError,
}: {
  readonly environmentId: EnvironmentId;
  readonly overview: UsageSharingOverview;
  readonly onCreated: (label: string, code: string) => void;
  readonly onError: (message: string | null) => void;
}) {
  const createGrant = useAtomCommand(usageSharingEnvironment.createGrant, { reportFailure: false });
  const usable = overview.sources
    .filter((source) => source.configured)
    .map((source) => source.kind);
  const [sourceKind, setSourceKind] = useState<UsageShareSourceKind>(usable[0] ?? "ollama");
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [models, setModels] = useState("");
  const [requests, setRequests] = useState("200");
  const [tokens, setTokens] = useState("");
  const [period, setPeriod] = useState<UsageSharePeriod>("day");
  const [concurrent, setConcurrent] = useState("2");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const days = numberOrNull(expiresInDays);
    const result = await createGrant({
      environmentId,
      input: {
        label: label.trim() || SOURCE_LABELS[sourceKind],
        recipientNote: note,
        sourceKind,
        models: models
          .split(/[,\n]/)
          .map((model) => model.trim())
          .filter(Boolean),
        limits: {
          maxRequests: numberOrNull(requests),
          maxTokens: numberOrNull(tokens),
          period,
          maxConcurrent: Math.min(8, Math.max(1, numberOrNull(concurrent) ?? 1)),
        },
        expiresAt: days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString(),
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      onError(null);
      setLabel("");
      setNote("");
      onCreated(result.value.grant.label, result.value.code);
    } else {
      onError(failureText(result));
    }
  };

  return (
    <form
      className="grid gap-3 border-b border-border/60 px-4 py-4 sm:grid-cols-2 sm:px-5"
      data-create-share-code
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="grid gap-1 text-xs">
        <span className="font-medium">What to share</span>
        <select
          aria-label="Shared source"
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          value={sourceKind}
          onChange={(event) => setSourceKind(event.currentTarget.value as UsageShareSourceKind)}
        >
          {overview.sources.map((source) => (
            <option key={source.kind} value={source.kind} disabled={!source.configured}>
              {SOURCE_LABELS[source.kind]}
              {source.configured ? "" : " (add a key first)"}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs">
        <span className="font-medium">Name recipients see</span>
        <Input
          aria-label="Share name"
          placeholder="Alex's Claude"
          value={label}
          onChange={(event) => setLabel(event.currentTarget.value)}
        />
      </label>
      <label className="grid gap-1 text-xs sm:col-span-2">
        <span className="font-medium">Models (comma separated)</span>
        <Input
          aria-label="Shared models"
          placeholder={MODEL_HINTS[sourceKind]}
          value={models}
          onChange={(event) => setModels(event.currentTarget.value)}
        />
      </label>
      <label className="grid gap-1 text-xs">
        <span className="font-medium">Requests allowed</span>
        <Input
          aria-label="Request limit"
          inputMode="numeric"
          placeholder="No limit"
          value={requests}
          onChange={(event) => setRequests(event.currentTarget.value)}
        />
      </label>
      <label className="grid gap-1 text-xs">
        <span className="font-medium">Tokens allowed</span>
        <Input
          aria-label="Token limit"
          inputMode="numeric"
          placeholder="No limit"
          value={tokens}
          onChange={(event) => setTokens(event.currentTarget.value)}
        />
      </label>
      <label className="grid gap-1 text-xs">
        <span className="font-medium">Limits reset</span>
        <select
          aria-label="Limit period"
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          value={period}
          onChange={(event) => setPeriod(event.currentTarget.value as UsageSharePeriod)}
        >
          {(Object.keys(PERIOD_LABELS) as UsageSharePeriod[]).map((value) => (
            <option key={value} value={value}>
              {value === "total" ? "Never (total allowance)" : `Every ${value} (UTC)`}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs">
        <span className="font-medium">Requests at a time</span>
        <Input
          aria-label="Concurrent requests"
          inputMode="numeric"
          value={concurrent}
          onChange={(event) => setConcurrent(event.currentTarget.value)}
        />
      </label>
      <label className="grid gap-1 text-xs">
        <span className="font-medium">Expires after (days, optional)</span>
        <Input
          aria-label="Expires after days"
          inputMode="numeric"
          placeholder="Never (until you revoke it)"
          value={expiresInDays}
          onChange={(event) => setExpiresInDays(event.currentTarget.value)}
        />
      </label>
      <label className="grid gap-1 text-xs">
        <span className="font-medium">Private note (only you see it)</span>
        <Input
          aria-label="Private note"
          placeholder="For Sam's laptop"
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
        />
      </label>
      <p className="text-xs text-muted-foreground sm:col-span-2">
        Limits are counted by this computer from what the provider reports for each request. A
        share-of-your-plan percentage is not offered: API keys and local models have no plan quota
        to measure against.
      </p>
      <div className="sm:col-span-2">
        <Button type="submit" size="sm" disabled={busy || overview.endpoint === null}>
          {busy ? "Creating…" : "Generate sharing code"}
        </Button>
        {overview.endpoint === null ? (
          <span className="ms-2 text-xs text-muted-foreground">
            Set this computer's address above first.
          </span>
        ) : null}
      </div>
    </form>
  );
}

function NewCodeNotice({
  label,
  code,
  onDismiss,
}: {
  readonly label: string;
  readonly code: string;
  readonly onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="space-y-2 border-b border-border/60 bg-muted/40 px-4 py-3 sm:px-5"
      data-new-share-code
    >
      <p className="text-sm font-medium">Sharing code for “{label}”</p>
      <p className="text-xs text-muted-foreground">
        Copy it now and send it privately. It is shown only once; anyone with it can use this share
        until you pause or revoke it.
      </p>
      <code
        className="block break-all rounded-md bg-background p-2 font-mono text-xs"
        data-share-code
      >
        {code}
      </code>
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() => void navigator.clipboard.writeText(code).then(() => setCopied(true))}
        >
          <CopyIcon />
          {copied ? "Copied" : "Copy code"}
        </Button>
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  );
}

function GrantRow({
  environmentId,
  grant,
  onDone,
  onNewCode,
}: {
  readonly environmentId: EnvironmentId;
  readonly grant: UsageShareGrant;
  readonly onDone: (result: CommandResult) => void;
  readonly onNewCode: (code: string) => void;
}) {
  const updateGrant = useAtomCommand(usageSharingEnvironment.updateGrant, { reportFailure: false });
  const revokeGrant = useAtomCommand(usageSharingEnvironment.revokeGrant, { reportFailure: false });
  const rotateGrant = useAtomCommand(usageSharingEnvironment.rotateGrant, { reportFailure: false });
  const badge = STATUS_BADGE[grant.status];
  const used = grant.usage.requests;
  const tokens = grant.usage.inputTokens + grant.usage.outputTokens;
  const fraction = Math.max(
    grant.limits.maxRequests ? used / grant.limits.maxRequests : 0,
    grant.limits.maxTokens ? tokens / grant.limits.maxTokens : 0,
  );

  return (
    <SettingsRow
      data-share-grant={grant.id}
      title={
        <span className="flex flex-wrap items-center gap-2">
          {grant.label}
          <Badge variant={badge.variant}>{badge.label}</Badge>
          {fraction >= 0.8 && grant.status === "active" ? (
            <Badge variant="warning">Nearly used up</Badge>
          ) : null}
        </span>
      }
      description={
        <span className="block space-y-0.5">
          <span className="block">
            {SOURCE_LABELS[grant.sourceKind]} · {grant.models.join(", ")}
            {grant.recipientNote ? ` · ${grant.recipientNote}` : ""}
          </span>
          <span className="block" data-share-usage>
            Used {used.toLocaleString()} request{used === 1 ? "" : "s"} and{" "}
            {tokens.toLocaleString()} tokens {PERIOD_LABELS[grant.limits.period]} ·{" "}
            {describeLimits(grant.limits)}
            {grant.expiresAt ? ` · expires ${new Date(grant.expiresAt).toLocaleDateString()}` : ""}
          </span>
        </span>
      }
      control={
        <div className="flex flex-wrap justify-end gap-1">
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void updateGrant({
                environmentId,
                input: { id: grant.id, paused: grant.status !== "paused" },
              }).then(onDone)
            }
          >
            {grant.status === "paused" ? "Resume" : "Pause"}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void updateGrant({ environmentId, input: { id: grant.id, resetUsage: true } }).then(
                onDone,
              )
            }
          >
            Reset usage
          </Button>
          <Button
            size="xs"
            variant="ghost"
            aria-label="Replace code"
            onClick={async () => {
              const confirmed = await (requestConfirmDialog(
                "Replace this code? The old code stops working immediately; you get a new one to send.",
              ) ?? Promise.resolve(true));
              if (!confirmed) return;
              const result = await rotateGrant({ environmentId, input: { id: grant.id } });
              if (result._tag === "Success") onNewCode(result.value.code);
              onDone(result);
            }}
          >
            <RefreshCwIcon />
          </Button>
          <Button
            size="xs"
            variant="destructive-outline"
            onClick={async () => {
              const confirmed = await (requestConfirmDialog(
                `Revoke “${grant.label}”? Anyone using it loses access immediately. This cannot be undone.`,
              ) ?? Promise.resolve(true));
              if (confirmed) onDone(await revokeGrant({ environmentId, input: { id: grant.id } }));
            }}
          >
            Revoke
          </Button>
        </div>
      }
    />
  );
}

function ConnectionRow({
  environmentId,
  connection,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly connection: UsageSharingOverview["connections"][number];
  readonly onDone: (result: CommandResult) => void;
}) {
  const refresh = useAtomCommand(usageSharingEnvironment.refreshConnection, {
    reportFailure: false,
  });
  const remove = useAtomCommand(usageSharingEnvironment.removeConnection, { reportFailure: false });
  const ready = connection.status === "ready";
  const used = connection.usage?.requests ?? 0;
  return (
    <SettingsRow
      data-share-connection={connection.id}
      title={
        <span className="flex items-center gap-2">
          {connection.label}
          <Badge variant={ready ? "success" : "warning"}>
            {ready ? "Connected" : connection.status.replace("-", " ")}
          </Badge>
        </span>
      }
      description={
        <span className="block">
          {SOURCE_LABELS[connection.sourceKind]} via {connection.endpointHost} ·{" "}
          {connection.models.join(", ")}
          {connection.limits
            ? ` · used ${used} ${PERIOD_LABELS[connection.limits.period]} (${describeLimits(connection.limits)})`
            : ""}
          {connection.statusMessage ? ` · ${connection.statusMessage}` : ""}
        </span>
      }
      control={
        <div className="flex gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void refresh({ environmentId, input: { id: connection.id } }).then(onDone)
            }
          >
            Check
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void remove({ environmentId, input: { id: connection.id } }).then(onDone)
            }
          >
            Remove
          </Button>
        </div>
      }
    />
  );
}
