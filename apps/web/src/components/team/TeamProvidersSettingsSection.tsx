import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  canManageTeamProviders,
  defaultTeamProviderDeliveryStrategy,
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
  type TeamMember,
  type TeamMemberId,
  type TeamProvider,
  type TeamProviderDeliveryStrategy,
  type TeamProviderUsageSummary,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { CloudIcon, KeyRoundIcon, RefreshCwIcon, ShieldAlertIcon, Trash2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { m } from "~/i18n/messages";
import { teamEnvironment } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";

const TEAM_PROVIDER_DRIVER_OPTIONS: ReadonlyArray<{
  readonly value: string;
  readonly label: string;
}> = [
  { value: "codex", label: "Codex" },
  { value: "claudeAgent", label: "Claude Code" },
  // oxlint-disable-next-line t3code/no-untranslated-copy -- Proper provider name.
  { value: "antigravity", label: "Antigravity (Gemini)" },
  // oxlint-disable-next-line t3code/no-untranslated-copy -- Technical protocol name.
  { value: "acpRegistry", label: "ACP / Custom Gateway" },
  { value: "opencode", label: "OpenCode" },
  { value: "cursor", label: "Cursor" },
  { value: "grok", label: "Grok" },
  { value: "pi", label: "Pi" },
  { value: "kiro", label: "Kiro" },
];

const DELIVERY_STRATEGY_OPTIONS: ReadonlyArray<TeamProviderDeliveryStrategy> = [
  "proxy",
  "token-lease",
  "remote-only",
];

function strategyBadgeVariant(
  strategy: TeamProviderDeliveryStrategy,
): "info" | "success" | "warning" {
  if (strategy === "proxy") return "success";
  if (strategy === "token-lease") return "info";
  return "warning";
}

export function TeamProvidersSettingsSection({
  environmentId,
  currentMember,
  memberById,
  providers,
}: {
  readonly environmentId: EnvironmentId;
  readonly currentMember: TeamMember | null;
  readonly memberById: ReadonlyMap<TeamMemberId, TeamMember>;
  readonly providers: ReadonlyArray<TeamProvider>;
}) {
  const gt = useGT();
  const canManageScope = useAtomValue(teamEnvironment.upsertProvider.permissionAtom(environmentId));
  const canManage =
    canManageScope &&
    currentMember !== null &&
    currentMember.status === "active" &&
    canManageTeamProviders(currentMember.role);

  const runUpsertProvider = useAtomCommand(teamEnvironment.upsertProvider, {
    reportFailure: false,
  });
  const runDeleteProvider = useAtomCommand(teamEnvironment.deleteProvider, {
    reportFailure: false,
  });
  const runListUsage = useAtomCommand(teamEnvironment.listProviderUsage, {
    reportFailure: false,
  });

  const [instanceIdInput, setInstanceIdInput] = useState("");
  const [driverInput, setDriverInput] = useState("claudeAgent");
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [strategyInput, setStrategyInput] = useState<TeamProviderDeliveryStrategy>(
    defaultTeamProviderDeliveryStrategy(ProviderDriverKind.make("claudeAgent")),
  );
  const [upstreamBaseUrlInput, setUpstreamBaseUrlInput] = useState("");
  const [apiKeyHeaderInput, setApiKeyHeaderInput] = useState("");
  const [apiKeyPrefixInput, setApiKeyPrefixInput] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [oauthAccessTokenInput, setOauthAccessTokenInput] = useState("");
  const [oauthRefreshTokenInput, setOauthRefreshTokenInput] = useState("");
  const [oauthTokenEndpointInput, setOauthTokenEndpointInput] = useState("");
  const [oauthClientIdInput, setOauthClientIdInput] = useState("");
  const [oauthClientSecretInput, setOauthClientSecretInput] = useState("");
  const [enabledInput, setEnabledInput] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [usageRows, setUsageRows] = useState<ReadonlyArray<TeamProviderUsageSummary> | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(false);

  const reportError = (title: string, error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: thrownErrorMessage(error, m) ?? title,
    });
  };

  const resetForm = () => {
    setInstanceIdInput("");
    setDisplayNameInput("");
    setUpstreamBaseUrlInput("");
    setApiKeyHeaderInput("");
    setApiKeyPrefixInput("");
    setApiKeyInput("");
    setOauthAccessTokenInput("");
    setOauthRefreshTokenInput("");
    setOauthTokenEndpointInput("");
    setOauthClientIdInput("");
    setOauthClientSecretInput("");
    setEnabledInput(true);
  };

  const handleEditProvider = (provider: TeamProvider) => {
    setInstanceIdInput(provider.providerInstanceId);
    setDriverInput(provider.driver);
    setDisplayNameInput(provider.displayName ?? "");
    setStrategyInput(provider.deliveryStrategy);
    setUpstreamBaseUrlInput(provider.upstreamBaseUrl ?? "");
    setApiKeyHeaderInput(provider.apiKeyHeader ?? "");
    setApiKeyPrefixInput(provider.apiKeyPrefix ?? "");
    setApiKeyInput("");
    setOauthAccessTokenInput("");
    setOauthRefreshTokenInput("");
    setOauthTokenEndpointInput("");
    setOauthClientIdInput("");
    setOauthClientSecretInput("");
    setEnabledInput(provider.enabled);
  };

  const handleSaveProvider = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedId = instanceIdInput.trim();
    if (trimmedId.length === 0) {
      reportError(
        gt("Could not save team provider"),
        new Error(gt("Enter a provider instance ID (for example, team-openai).")),
      );
      return;
    }
    if (strategyInput === "proxy" && upstreamBaseUrlInput.trim().length === 0) {
      reportError(
        gt("Could not save team provider"),
        new Error(gt("Proxy providers require an upstream base URL.")),
      );
      return;
    }
    setSaving(true);
    const result = await runUpsertProvider({
      environmentId,
      input: {
        providerInstanceId: ProviderInstanceId.make(trimmedId),
        driver: ProviderDriverKind.make(driverInput),
        displayName: displayNameInput.trim() || null,
        deliveryStrategy: strategyInput,
        upstreamBaseUrl: upstreamBaseUrlInput.trim() || null,
        apiKeyHeader: apiKeyHeaderInput.trim() || null,
        apiKeyPrefix: apiKeyPrefixInput.length > 0 ? apiKeyPrefixInput : null,
        enabled: enabledInput,
        ...(apiKeyInput.trim().length > 0 ? { apiKey: apiKeyInput.trim() } : {}),
        ...(oauthAccessTokenInput.trim().length > 0
          ? { oauthAccessToken: oauthAccessTokenInput.trim() }
          : {}),
        ...(oauthRefreshTokenInput.trim().length > 0
          ? { oauthRefreshToken: oauthRefreshTokenInput.trim() }
          : {}),
        ...(oauthTokenEndpointInput.trim().length > 0
          ? { oauthTokenEndpoint: oauthTokenEndpointInput.trim() }
          : {}),
        ...(oauthClientIdInput.trim().length > 0
          ? { oauthClientId: oauthClientIdInput.trim() }
          : {}),
        ...(oauthClientSecretInput.trim().length > 0
          ? { oauthClientSecret: oauthClientSecretInput.trim() }
          : {}),
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      resetForm();
      toastManager.add({
        type: "success",
        title: gt("Team provider saved"),
        description: result.value.displayName ?? result.value.providerInstanceId,
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not save team provider"), squashAtomCommandFailure(result));
    }
  };

  const handleDeleteProvider = async (providerInstanceId: ProviderInstanceId) => {
    setDeletingId(providerInstanceId);
    const result = await runDeleteProvider({
      environmentId,
      input: { providerInstanceId },
    });
    setDeletingId(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Team provider removed"),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not remove team provider"), squashAtomCommandFailure(result));
    }
  };

  const handleRefreshUsage = async () => {
    setLoadingUsage(true);
    const result = await runListUsage({ environmentId, input: {} });
    setLoadingUsage(false);
    if (result._tag === "Success") {
      setUsageRows(result.value.usage);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not load provider usage"), squashAtomCommandFailure(result));
    }
  };

  return (
    <SettingsSection
      id="teams-providers"
      title={gt("Team providers")}
      icon={<CloudIcon className="size-4" />}
    >
      <SettingsRow
        title={gt("Zero-config provider delivery")}
        description={
          canManage
            ? gt(
                "Configure company API keys or OAuth sessions once on the Team Server. Teammates automatically receive isolated team providers without signing in locally.",
              )
            : gt(
                "Team providers are configured by team admins on the Team Server and automatically provisioned to your isolated team profiles.",
              )
        }
      >
        <div className="mt-2 space-y-2 pb-3" data-testid="team-providers-list">
          {providers.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              <T>No team providers configured yet.</T>
            </p>
          ) : (
            providers.map((provider) => {
              const updater = memberById.get(provider.updatedByMemberId)?.pseudo ?? "admin";
              return (
                <div
                  key={provider.id}
                  data-testid={`team-provider-row-${provider.providerInstanceId}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium">
                        {provider.displayName ?? provider.providerInstanceId}
                      </span>
                      <Badge variant="outline" size="sm">
                        {provider.driver}
                      </Badge>
                      <Badge variant={strategyBadgeVariant(provider.deliveryStrategy)} size="sm">
                        {provider.deliveryStrategy}
                      </Badge>
                      {!provider.enabled ? (
                        <Badge variant="secondary" size="sm">
                          <T>Disabled</T>
                        </Badge>
                      ) : null}
                      {provider.hasSecret ? (
                        <Badge variant="outline" size="sm">
                          <KeyRoundIcon className="mr-1 size-3" />
                          <T>Credentials stored</T>
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {provider.deliveryStrategy === "remote-only" ? (
                        <span className="inline-flex items-center gap-1 text-warning-foreground">
                          <ShieldAlertIcon className="size-3" />
                          <T>
                            Runs on remote team environments only (never exposes refresh tokens
                            locally).
                          </T>
                        </span>
                      ) : (
                        <>
                          {provider.providerInstanceId}
                          {provider.upstreamBaseUrl ? ` · ${provider.upstreamBaseUrl}` : ""}
                          {` · ${gt("Updated by {pseudo}", { pseudo: updater })}`}
                        </>
                      )}
                    </p>
                  </div>
                  {canManage ? (
                    <div className="flex items-center gap-1.5">
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => handleEditProvider(provider)}
                      >
                        <T>Edit</T>
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={deletingId === provider.providerInstanceId}
                        onClick={() => void handleDeleteProvider(provider.providerInstanceId)}
                        data-testid={`team-provider-delete-${provider.providerInstanceId}`}
                      >
                        <Trash2Icon />
                        <T>Remove</T>
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </SettingsRow>

      {canManage ? (
        <>
          <SettingsRow
            title={gt("Add or update team provider")}
            description={gt(
              "Secrets are write-only and stored encrypted on the Team Server. Leave secret fields blank when updating metadata to keep stored credentials.",
            )}
          >
            <form
              className="mt-2 space-y-3 pb-3"
              onSubmit={(event) => void handleSaveProvider(event)}
              data-testid="team-provider-form"
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    <T>Provider instance ID</T>
                  </p>
                  <Input
                    data-testid="team-provider-id-input"
                    value={instanceIdInput}
                    onChange={(event) => setInstanceIdInput(event.currentTarget.value)}
                    placeholder="team-openai"
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    <T>Display name</T>
                  </p>
                  <Input
                    data-testid="team-provider-name-input"
                    value={displayNameInput}
                    onChange={(event) => setDisplayNameInput(event.currentTarget.value)}
                    placeholder={gt("Company OpenAI")}
                  />
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    <T>Provider driver</T>
                  </p>
                  <Select
                    value={driverInput}
                    onValueChange={(value) => {
                      if (!value) return;
                      setDriverInput(value);
                      setStrategyInput(
                        defaultTeamProviderDeliveryStrategy(ProviderDriverKind.make(value)),
                      );
                    }}
                  >
                    <SelectTrigger data-testid="team-provider-driver-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {TEAM_PROVIDER_DRIVER_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>

                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    <T>Delivery strategy</T>
                  </p>
                  <Select
                    value={strategyInput}
                    onValueChange={(value) => {
                      if (value === "proxy" || value === "token-lease" || value === "remote-only") {
                        setStrategyInput(value);
                      }
                    }}
                  >
                    <SelectTrigger data-testid="team-provider-strategy-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {DELIVERY_STRATEGY_OPTIONS.map((strategy) => (
                        <SelectItem key={strategy} value={strategy}>
                          {strategy}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>

              {strategyInput === "proxy" ? (
                <div className="space-y-2 rounded-lg border border-border/60 p-3">
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">
                      <T>Upstream base URL</T>
                    </p>
                    <Input
                      data-testid="team-provider-upstream-url-input"
                      value={upstreamBaseUrlInput}
                      onChange={(event) => setUpstreamBaseUrlInput(event.currentTarget.value)}
                      placeholder="https://api.openai.com/v1"
                    />
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="space-y-1 sm:col-span-1">
                      <p className="text-xs font-medium text-muted-foreground">
                        <T>Company API key (write-only)</T>
                      </p>
                      <Input
                        type="password"
                        data-testid="team-provider-apikey-input"
                        value={apiKeyInput}
                        onChange={(event) => setApiKeyInput(event.currentTarget.value)}
                        placeholder="sk-..."
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">
                        <T>Auth header (optional)</T>
                      </p>
                      <Input
                        value={apiKeyHeaderInput}
                        onChange={(event) => setApiKeyHeaderInput(event.currentTarget.value)}
                        // oxlint-disable-next-line t3code/no-untranslated-copy -- HTTP header name.
                        placeholder="Authorization"
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">
                        <T>Header prefix (optional)</T>
                      </p>
                      <Input
                        value={apiKeyPrefixInput}
                        onChange={(event) => setApiKeyPrefixInput(event.currentTarget.value)}
                        // oxlint-disable-next-line t3code/no-untranslated-copy -- HTTP auth scheme prefix.
                        placeholder="Bearer "
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              {strategyInput === "token-lease" ? (
                <div className="space-y-2 rounded-lg border border-border/60 p-3">
                  <p className="text-xs text-muted-foreground">
                    <T>
                      The Team Server holds the sole OAuth refresh token and leases short-lived
                      access tokens to active teammates. Refresh tokens never leave the Team Server.
                    </T>
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">
                        <T>OAuth access token (write-only)</T>
                      </p>
                      <Input
                        type="password"
                        data-testid="team-provider-oauth-access-input"
                        value={oauthAccessTokenInput}
                        onChange={(event) => setOauthAccessTokenInput(event.currentTarget.value)}
                        placeholder="ya29...."
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">
                        <T>OAuth refresh token (write-only)</T>
                      </p>
                      <Input
                        type="password"
                        data-testid="team-provider-oauth-refresh-input"
                        value={oauthRefreshTokenInput}
                        onChange={(event) => setOauthRefreshTokenInput(event.currentTarget.value)}
                        placeholder="1//..."
                      />
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">
                        <T>Token endpoint (optional)</T>
                      </p>
                      <Input
                        value={oauthTokenEndpointInput}
                        onChange={(event) => setOauthTokenEndpointInput(event.currentTarget.value)}
                        placeholder="https://oauth2.googleapis.com/token"
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">
                        <T>OAuth client ID (optional)</T>
                      </p>
                      <Input
                        value={oauthClientIdInput}
                        onChange={(event) => setOauthClientIdInput(event.currentTarget.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">
                        <T>OAuth client secret (optional)</T>
                      </p>
                      <Input
                        type="password"
                        value={oauthClientSecretInput}
                        onChange={(event) => setOauthClientSecretInput(event.currentTarget.value)}
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch checked={enabledInput} onCheckedChange={setEnabledInput} />
                  <span>
                    <T>Enabled</T>
                  </span>
                </label>
                <div className="flex items-center gap-2">
                  {instanceIdInput.trim().length > 0 ? (
                    <Button type="button" size="sm" variant="ghost" onClick={resetForm}>
                      <T>Clear</T>
                    </Button>
                  ) : null}
                  <Button
                    type="submit"
                    size="sm"
                    disabled={saving}
                    data-testid="team-provider-save-submit"
                  >
                    {saving ? <Spinner className="size-3.5" /> : null}
                    <T>Save provider</T>
                  </Button>
                </div>
              </div>
            </form>
          </SettingsRow>

          <SettingsRow
            title={gt("Centralized provider usage")}
            description={gt(
              "Per-member proxy and OAuth lease request counts recorded on this Team Server.",
            )}
          >
            <div className="mt-2 space-y-2 pb-3">
              <div>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={loadingUsage}
                  onClick={() => void handleRefreshUsage()}
                  data-testid="team-provider-usage-refresh"
                >
                  {loadingUsage ? (
                    <Spinner className="size-3" />
                  ) : (
                    <RefreshCwIcon className="size-3" />
                  )}
                  <T>Refresh usage</T>
                </Button>
              </div>
              {usageRows !== null ? (
                <div className="space-y-1.5" data-testid="team-provider-usage-list">
                  {usageRows.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      <T>No team provider requests recorded yet.</T>
                    </p>
                  ) : (
                    usageRows.map((row) => (
                      <div
                        key={`${row.memberId}:${row.providerInstanceId}:${row.strategy}`}
                        className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-xs"
                      >
                        <span className="font-medium">
                          {row.memberPseudo} · {row.providerInstanceId} ({row.strategy})
                        </span>
                        <span className="text-muted-foreground">
                          {gt("{count} requests", { count: row.requestCount })}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          </SettingsRow>
        </>
      ) : null}
    </SettingsSection>
  );
}
