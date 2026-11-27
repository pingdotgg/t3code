import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  canManageTeamProviders,
  defaultTeamProviderDeliveryStrategy,
  isTeamProviderInstanceId,
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
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloudIcon,
  KeyRoundIcon,
  Link2Icon,
  PlusIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  Trash2Icon,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { m } from "~/i18n/messages";
import { useEnvironmentProviders } from "~/state/environments";
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
import { confirmTeamDestructiveAction } from "./confirmTeamDestructiveAction";
import {
  formatTeamDeliveryStrategyLabel,
  formatTeamDriverLabel,
  TEAM_PROVIDER_DRIVER_OPTIONS,
} from "./teamProviderDrivers";

const DELIVERY_STRATEGY_OPTIONS: ReadonlyArray<TeamProviderDeliveryStrategy> = [
  "proxy",
  "token-lease",
  "remote-only",
];

const MANUAL_LINK_SENTINEL = "__manual__";

function strategyBadgeVariant(
  strategy: TeamProviderDeliveryStrategy,
): "info" | "success" | "warning" {
  if (strategy === "proxy") return "success";
  if (strategy === "token-lease") return "info";
  return "warning";
}

function readLinkedServerInstanceId(provider: TeamProvider): string {
  const raw = provider.config?.linkedServerInstanceId;
  return typeof raw === "string" ? raw : "";
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
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders = providersByEnvironment.get(environmentId) ?? [];

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

  const [showForm, setShowForm] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<ProviderInstanceId | null>(null);
  const [editingHasSecret, setEditingHasSecret] = useState(false);
  const [clearSecretInput, setClearSecretInput] = useState(false);
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
  const [linkedServerInstanceId, setLinkedServerInstanceId] = useState("");
  const [showManualOAuth, setShowManualOAuth] = useState(false);
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

  const linkableServerProviders = serverProviders.filter(
    (candidate) =>
      candidate.driver === driverInput && !isTeamProviderInstanceId(candidate.instanceId),
  );

  const selectedLinkedServerProvider =
    linkableServerProviders.find((candidate) => candidate.instanceId === linkedServerInstanceId) ??
    null;

  const reportError = (title: string, error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: thrownErrorMessage(error, m) ?? title,
    });
  };

  const resetForm = (closeForm = true) => {
    setEditingProviderId(null);
    setEditingHasSecret(false);
    setClearSecretInput(false);
    setInstanceIdInput("");
    setDisplayNameInput("");
    setUpstreamBaseUrlInput("");
    setApiKeyHeaderInput("");
    setApiKeyPrefixInput("");
    setApiKeyInput("");
    setLinkedServerInstanceId("");
    setShowManualOAuth(false);
    setOauthAccessTokenInput("");
    setOauthRefreshTokenInput("");
    setOauthTokenEndpointInput("");
    setOauthClientIdInput("");
    setOauthClientSecretInput("");
    setEnabledInput(true);
    if (closeForm) setShowForm(false);
  };

  const handleEditProvider = (provider: TeamProvider) => {
    const linked = readLinkedServerInstanceId(provider);
    setEditingProviderId(provider.providerInstanceId);
    setEditingHasSecret(provider.hasSecret);
    setClearSecretInput(false);
    setInstanceIdInput(provider.providerInstanceId);
    setDriverInput(provider.driver);
    setDisplayNameInput(provider.displayName ?? "");
    setStrategyInput(provider.deliveryStrategy);
    setUpstreamBaseUrlInput(provider.upstreamBaseUrl ?? "");
    setApiKeyHeaderInput(provider.apiKeyHeader ?? "");
    setApiKeyPrefixInput(provider.apiKeyPrefix ?? "");
    setApiKeyInput("");
    setLinkedServerInstanceId(linked);
    setShowManualOAuth(false);
    setOauthAccessTokenInput("");
    setOauthRefreshTokenInput("");
    setOauthTokenEndpointInput("");
    setOauthClientIdInput("");
    setOauthClientSecretInput("");
    setEnabledInput(provider.enabled);
    setShowForm(true);
  };

  const handleSaveProvider = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedId = (editingProviderId ?? instanceIdInput).trim();
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
    const trimmedLinkedId = linkedServerInstanceId.trim();
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
        ...(clearSecretInput ? { clearSecret: true } : {}),
        ...(strategyInput === "token-lease" && !clearSecretInput
          ? {
              sourceServerProviderInstanceId:
                trimmedLinkedId.length > 0 ? ProviderInstanceId.make(trimmedLinkedId) : null,
            }
          : {}),
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
      resetForm(true);
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

  const handleDeleteProvider = async (provider: TeamProvider) => {
    const label = provider.displayName ?? provider.providerInstanceId;
    const confirmed = await confirmTeamDestructiveAction(
      [
        gt('Remove team provider "{name}"?', { name: label }),
        gt(
          "Stored credentials will be deleted and teammates will no longer be able to run turns with this provider.",
        ),
      ].join("\n"),
    );
    if (!confirmed) return;

    setDeletingId(provider.providerInstanceId);
    const result = await runDeleteProvider({
      environmentId,
      input: { providerInstanceId: provider.providerInstanceId },
    });
    setDeletingId(null);
    if (result._tag === "Success") {
      if (editingProviderId === provider.providerInstanceId) {
        resetForm(true);
      }
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
      headerAction={
        canManage && !showForm ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-testid="team-provider-add-open"
            onClick={() => {
              resetForm(false);
              setShowForm(true);
            }}
          >
            <PlusIcon />
            <T>Add provider</T>
          </Button>
        ) : undefined
      }
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
              const linkedInstance = readLinkedServerInstanceId(provider);
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
                        {formatTeamDriverLabel(provider.driver, gt)}
                      </Badge>
                      <Badge variant={strategyBadgeVariant(provider.deliveryStrategy)} size="sm">
                        {formatTeamDeliveryStrategyLabel(provider.deliveryStrategy, gt)}
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
                      {linkedInstance ? (
                        <Badge variant="outline" size="sm">
                          <Link2Icon className="mr-1 size-3" />
                          {gt("Linked: {instance}", { instance: linkedInstance })}
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
                        data-testid={`team-provider-edit-${provider.providerInstanceId}`}
                        onClick={() => handleEditProvider(provider)}
                      >
                        <T>Edit</T>
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={deletingId === provider.providerInstanceId}
                        onClick={() => void handleDeleteProvider(provider)}
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

      {canManage && showForm ? (
        <SettingsRow
          title={editingProviderId ? gt("Edit team provider") : gt("Add team provider")}
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
                <label
                  className="block text-xs font-medium text-muted-foreground"
                  htmlFor="team-provider-id"
                >
                  <T>Provider instance ID</T>
                </label>
                <Input
                  id="team-provider-id"
                  data-testid="team-provider-id-input"
                  value={instanceIdInput}
                  onChange={(event) => setInstanceIdInput(event.currentTarget.value)}
                  placeholder="team-openai"
                  disabled={editingProviderId !== null}
                  readOnly={editingProviderId !== null}
                />
              </div>
              <div className="space-y-1">
                <label
                  className="block text-xs font-medium text-muted-foreground"
                  htmlFor="team-provider-name"
                >
                  <T>Display name</T>
                </label>
                <Input
                  id="team-provider-name"
                  data-testid="team-provider-name-input"
                  value={displayNameInput}
                  onChange={(event) => setDisplayNameInput(event.currentTarget.value)}
                  placeholder={gt("Company OpenAI")}
                />
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <label
                  className="block text-xs font-medium text-muted-foreground"
                  htmlFor="team-provider-driver"
                >
                  <T>Provider driver</T>
                </label>
                <Select
                  value={driverInput}
                  onValueChange={(value) => {
                    if (!value) return;
                    setDriverInput(value);
                    setLinkedServerInstanceId("");
                    setStrategyInput(
                      defaultTeamProviderDeliveryStrategy(ProviderDriverKind.make(value)),
                    );
                  }}
                >
                  <SelectTrigger
                    id="team-provider-driver"
                    data-testid="team-provider-driver-select"
                  >
                    <SelectValue>{formatTeamDriverLabel(driverInput, gt)}</SelectValue>
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
                <label
                  className="block text-xs font-medium text-muted-foreground"
                  htmlFor="team-provider-strategy"
                >
                  <T>Delivery strategy</T>
                </label>
                <Select
                  value={strategyInput}
                  onValueChange={(value) => {
                    if (value === "proxy" || value === "token-lease" || value === "remote-only") {
                      setStrategyInput(value);
                    }
                  }}
                >
                  <SelectTrigger
                    id="team-provider-strategy"
                    data-testid="team-provider-strategy-select"
                  >
                    <SelectValue>{formatTeamDeliveryStrategyLabel(strategyInput, gt)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {DELIVERY_STRATEGY_OPTIONS.map((strategy) => (
                      <SelectItem key={strategy} value={strategy}>
                        {formatTeamDeliveryStrategyLabel(strategy, gt)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>

            {strategyInput === "proxy" ? (
              <div className="space-y-2 rounded-lg border border-border/60 p-3">
                <div className="space-y-1">
                  <label
                    className="block text-xs font-medium text-muted-foreground"
                    htmlFor="team-provider-upstream-url"
                  >
                    <T>Upstream base URL</T>
                  </label>
                  <Input
                    id="team-provider-upstream-url"
                    data-testid="team-provider-upstream-url-input"
                    value={upstreamBaseUrlInput}
                    onChange={(event) => setUpstreamBaseUrlInput(event.currentTarget.value)}
                    placeholder="https://api.openai.com/v1"
                  />
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="space-y-1 sm:col-span-1">
                    <label
                      className="block text-xs font-medium text-muted-foreground"
                      htmlFor="team-provider-apikey"
                    >
                      <T>Company API key (write-only)</T>
                    </label>
                    <Input
                      id="team-provider-apikey"
                      type="password"
                      data-testid="team-provider-apikey-input"
                      value={apiKeyInput}
                      onChange={(event) => {
                        setApiKeyInput(event.currentTarget.value);
                        if (clearSecretInput) setClearSecretInput(false);
                      }}
                      placeholder="sk-..."
                    />
                  </div>
                  <div className="space-y-1">
                    <label
                      className="block text-xs font-medium text-muted-foreground"
                      htmlFor="team-provider-header"
                    >
                      <T>Auth header (optional)</T>
                    </label>
                    <Input
                      id="team-provider-header"
                      value={apiKeyHeaderInput}
                      onChange={(event) => setApiKeyHeaderInput(event.currentTarget.value)}
                      // oxlint-disable-next-line t3code/no-untranslated-copy -- HTTP header name.
                      placeholder="Authorization"
                    />
                  </div>
                  <div className="space-y-1">
                    <label
                      className="block text-xs font-medium text-muted-foreground"
                      htmlFor="team-provider-prefix"
                    >
                      <T>Header prefix (optional)</T>
                    </label>
                    <Input
                      id="team-provider-prefix"
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
              <div className="space-y-3 rounded-lg border border-border/60 p-3">
                <p className="text-xs text-muted-foreground">
                  <T>
                    The Team Server holds the sole OAuth refresh token and leases short-lived access
                    tokens to active teammates. Refresh tokens never leave the Team Server.
                  </T>
                </p>

                <div className="space-y-1.5">
                  <label
                    className="block text-xs font-medium text-foreground"
                    htmlFor="team-provider-link-server-instance"
                  >
                    <T>Link from Team Server&apos;s signed-in provider</T>
                  </label>
                  <Select
                    value={linkedServerInstanceId || MANUAL_LINK_SENTINEL}
                    onValueChange={(value) => {
                      if (!value || value === MANUAL_LINK_SENTINEL) {
                        setLinkedServerInstanceId("");
                        return;
                      }
                      setLinkedServerInstanceId(value);
                      setClearSecretInput(false);
                    }}
                  >
                    <SelectTrigger
                      id="team-provider-link-server-instance"
                      data-testid="team-provider-link-server-select"
                    >
                      <SelectValue>
                        {selectedLinkedServerProvider
                          ? `${selectedLinkedServerProvider.displayName ?? selectedLinkedServerProvider.instanceId} (${selectedLinkedServerProvider.instanceId})`
                          : linkedServerInstanceId
                            ? linkedServerInstanceId
                            : gt("Do not link (enter OAuth credentials manually)")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={MANUAL_LINK_SENTINEL}>
                        {gt("Do not link (enter OAuth credentials manually)")}
                      </SelectItem>
                      {linkableServerProviders.map((candidate) => (
                        <SelectItem key={candidate.instanceId} value={candidate.instanceId}>
                          {`${candidate.displayName ?? candidate.instanceId} (${candidate.instanceId})`}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <p className="text-2xs text-muted-foreground">
                    {linkableServerProviders.length > 0 ? (
                      <T>
                        Imports and leases tokens directly from a provider instance already signed
                        in under Settings → Providers on this Team Server.
                      </T>
                    ) : (
                      <T>
                        No matching provider instance is configured on this Team Server yet. Sign in
                        under Settings → Providers first, or expand manual OAuth credentials below.
                      </T>
                    )}
                  </p>
                </div>

                <div className="border-t border-border/50 pt-2">
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => setShowManualOAuth((open) => !open)}
                    data-testid="team-provider-manual-oauth-toggle"
                  >
                    {showManualOAuth ? (
                      <ChevronDownIcon className="size-3.5" />
                    ) : (
                      <ChevronRightIcon className="size-3.5" />
                    )}
                    <T>Advanced: manual OAuth credentials</T>
                  </Button>
                </div>

                {showManualOAuth ? (
                  <div className="space-y-2 pt-1" data-testid="team-provider-manual-oauth-fields">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label
                          className="block text-xs font-medium text-muted-foreground"
                          htmlFor="team-provider-oauth-access"
                        >
                          <T>OAuth access token (write-only)</T>
                        </label>
                        <Input
                          id="team-provider-oauth-access"
                          type="password"
                          data-testid="team-provider-oauth-access-input"
                          value={oauthAccessTokenInput}
                          onChange={(event) => {
                            setOauthAccessTokenInput(event.currentTarget.value);
                            if (clearSecretInput) setClearSecretInput(false);
                          }}
                          placeholder="ya29...."
                        />
                      </div>
                      <div className="space-y-1">
                        <label
                          className="block text-xs font-medium text-muted-foreground"
                          htmlFor="team-provider-oauth-refresh"
                        >
                          <T>OAuth refresh token (write-only)</T>
                        </label>
                        <Input
                          id="team-provider-oauth-refresh"
                          type="password"
                          data-testid="team-provider-oauth-refresh-input"
                          value={oauthRefreshTokenInput}
                          onChange={(event) => {
                            setOauthRefreshTokenInput(event.currentTarget.value);
                            if (clearSecretInput) setClearSecretInput(false);
                          }}
                          placeholder="1//..."
                        />
                      </div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <div className="space-y-1">
                        <label
                          className="block text-xs font-medium text-muted-foreground"
                          htmlFor="team-provider-oauth-endpoint"
                        >
                          <T>Token endpoint (optional)</T>
                        </label>
                        <Input
                          id="team-provider-oauth-endpoint"
                          value={oauthTokenEndpointInput}
                          onChange={(event) =>
                            setOauthTokenEndpointInput(event.currentTarget.value)
                          }
                          placeholder="https://oauth2.googleapis.com/token"
                        />
                      </div>
                      <div className="space-y-1">
                        <label
                          className="block text-xs font-medium text-muted-foreground"
                          htmlFor="team-provider-oauth-client-id"
                        >
                          <T>OAuth client ID (optional)</T>
                        </label>
                        <Input
                          id="team-provider-oauth-client-id"
                          value={oauthClientIdInput}
                          onChange={(event) => setOauthClientIdInput(event.currentTarget.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <label
                          className="block text-xs font-medium text-muted-foreground"
                          htmlFor="team-provider-oauth-client-secret"
                        >
                          <T>OAuth client secret (optional)</T>
                        </label>
                        <Input
                          id="team-provider-oauth-client-secret"
                          type="password"
                          value={oauthClientSecretInput}
                          onChange={(event) => setOauthClientSecretInput(event.currentTarget.value)}
                        />
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch checked={enabledInput} onCheckedChange={setEnabledInput} />
                  <span>
                    <T>Enabled</T>
                  </span>
                </label>
                {editingProviderId !== null && editingHasSecret ? (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch
                      checked={clearSecretInput}
                      onCheckedChange={(checked) => {
                        setClearSecretInput(checked);
                        if (checked) {
                          setLinkedServerInstanceId("");
                        }
                      }}
                      data-testid="team-provider-clear-secret-switch"
                    />
                    <span>
                      <T>Clear stored credentials</T>
                    </span>
                  </label>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => resetForm(true)}>
                  <T>Cancel</T>
                </Button>
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
      ) : null}

      {canManage ? (
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
                        {row.memberPseudo} · {row.providerInstanceId} (
                        {formatTeamDeliveryStrategyLabel(row.strategy, gt)})
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
      ) : null}
    </SettingsSection>
  );
}
