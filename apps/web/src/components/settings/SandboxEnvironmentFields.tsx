import { ExternalLinkIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import type {
  EnvironmentId,
  SandboxCreateResult,
  SandboxCredentialEnvironment,
  SandboxProviderInfo,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { EnvironmentModeCard } from "./EnvironmentModeCard";
import { SandboxProviderLogo } from "./SandboxProviderLogo";
import {
  describeSandboxFailure,
  SandboxQuotaLine,
  SandboxStartBlocked,
  SandboxStartConfirmation,
  useSandboxStartCheck,
} from "./SandboxStartLimits";
import { useSandboxTemplates } from "./SandboxTemplates";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { connectPairing as connectPairingAtom } from "~/connection/onboarding";
import { readEnvironmentScope } from "~/state/session";
import { AuthSettingsWriteScope } from "@t3tools/contracts";

const EMPTY_PROVIDERS: ReadonlyArray<SandboxProviderInfo> = [];
const EMPTY_CREDENTIAL_ENVIRONMENTS: ReadonlyArray<SandboxCredentialEnvironment> = [];
const NO_CREDENTIAL_ENVIRONMENT = "__none__";
const FRESH_MACHINE = "__fresh__";

const describeCredentialEnvironment = (
  environment: SandboxCredentialEnvironment,
  providerLabel: string,
): string => {
  if (environment.safeForThirdParties) {
    return environment.proxyAiCredentials
      ? `Passes nothing. AI calls go through ${providerLabel}'s proxy, so real keys stay outside the sandbox.`
      : "Passes nothing: no secrets, GitHub token, or agent logins.";
  }
  const passes = [
    environment.passGithub ? "GitHub token and repositories" : null,
    environment.passSecrets ? "environment secrets" : null,
    environment.passAgentsCredentials ? "agent logins" : null,
    environment.passSandboxCredentials ? "sandbox credentials" : null,
  ].filter((value): value is string => value !== null);
  return passes.length === 0 ? "Passes no credentials." : `Passes ${passes.join(", ")}.`;
};

const formatFailure = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Failed to create sandbox.";

// T3's default sandbox lifetime; a plan with a shorter auto-stop maximum is called out.
const DEFAULT_TTL_MINUTES = 480;

const providerDefaultSize = (provider: SandboxProviderInfo): string =>
  provider.sizes[1]?.id ?? provider.sizes[0]?.id ?? "";

export function SandboxEnvironmentFields({
  environmentId,
  error,
  onErrorChange,
  onProvisioningChange,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly error: string | null;
  readonly onErrorChange: (error: string | null) => void;
  /** Lets the dialog lock its mode cards and refuse to close while a machine is being created. */
  readonly onProvisioningChange?: (provisioning: boolean) => void;
  readonly onDone: () => void;
}) {
  const providersQuery = useEnvironmentQuery(
    serverEnvironment.sandboxesProviders({ environmentId, input: undefined }),
  );
  const createSandbox = useAtomCommand(serverEnvironment.sandboxesCreate, {
    reportFailure: false,
  });
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const [selectedKind, setSelectedKind] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  // Edits to the provider's settings fields; untouched fields show the saved value.
  const [settingsDraft, setSettingsDraft] = useState<Readonly<Record<string, string>>>({});
  const [label, setLabel] = useState("");
  const [size, setSize] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [credentialEnvironment, setCredentialEnvironment] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [allowCredentials, setAllowCredentials] = useState(false);
  const [isProvisioning, setIsProvisioning] = useState(false);
  const providers = providersQuery.data?.providers ?? EMPTY_PROVIDERS;
  const provider = providers.find((candidate) => candidate.kind === selectedKind) ?? providers[0];
  const templates = useSandboxTemplates(environmentId, provider);
  const template = templates.templates.find((candidate) => candidate.name === templateName);
  // A template keeps the machine size it was saved from.
  const selectedSize =
    template !== undefined
      ? (template.size ?? "")
      : size === ""
        ? provider
          ? providerDefaultSize(provider)
          : ""
        : size;
  const environmentsQuery = useEnvironmentQuery(
    provider?.capabilities.credentialEnvironments
      ? serverEnvironment.sandboxesEnvironments({
          environmentId,
          input: { provider: provider.kind },
        })
      : null,
  );
  const startCheck = useSandboxStartCheck({ environmentId, provider, size: selectedSize });
  const sizeAvailability = new Map(
    (startCheck.limits?.sizes ?? []).map((entry) => [entry.id, entry] as const),
  );
  const credentialEnvironments =
    environmentsQuery.data?.environments ?? EMPTY_CREDENTIAL_ENVIRONMENTS;
  const selectedCredentialEnvironment = credentialEnvironments.find(
    (candidate) => candidate.name === credentialEnvironment,
  );
  const passesCredentials =
    selectedCredentialEnvironment !== undefined &&
    !selectedCredentialEnvironment.safeForThirdParties &&
    (selectedCredentialEnvironment.passGithub ||
      selectedCredentialEnvironment.passSecrets ||
      selectedCredentialEnvironment.passAgentsCredentials ||
      selectedCredentialEnvironment.passSandboxCredentials);
  const canWriteSettings = readEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const disabled =
    isProvisioning ||
    provider === undefined ||
    !canWriteSettings ||
    startCheck.blocked !== null ||
    (passesCredentials && !allowCredentials);

  const settingsFields = provider?.settingsFields ?? [];
  const settingValue = (id: string) => settingsDraft[id] ?? provider?.settings?.[id] ?? "";

  const handleCreate = async () => {
    if (provider === undefined) return;
    startCheck.cancel();
    setIsProvisioning(true);
    onProvisioningChange?.(true);
    onErrorChange(null);
    const created = await createSandbox({
      environmentId,
      input: {
        provider: provider.kind,
        ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
        ...(settingsFields.length === 0
          ? {}
          : {
              settings: Object.fromEntries(
                settingsFields.map((field) => [field.id, settingValue(field.id).trim()]),
              ),
            }),
        ...(label.trim() === "" ? {} : { label: label.trim() }),
        ...(template !== undefined
          ? { template: template.name }
          : selectedSize === ""
            ? {}
            : { size: selectedSize }),
        ...(repositoryUrl.trim() === "" ? {} : { repositoryUrl: repositoryUrl.trim() }),
        ...(credentialEnvironment === ""
          ? {}
          : { environment: credentialEnvironment, allowCredentials: true }),
      },
    });
    // Any attempt can spend a start, so the quota line re-reads the provider either way.
    startCheck.refresh();
    if (created._tag === "Failure") {
      if (!isAtomCommandInterrupted(created)) {
        const failure = describeSandboxFailure(
          squashAtomCommandFailure(created),
          "Could not create sandbox",
        );
        onErrorChange(failure.description);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: failure.title,
            description: failure.description,
          }),
        );
      }
      setIsProvisioning(false);
      onProvisioningChange?.(false);
      return;
    }

    const sandbox = created.value as SandboxCreateResult;
    const connected = await connectPairing({
      host: sandbox.httpBaseUrl,
      pairingCode: sandbox.pairingCode,
    });
    setIsProvisioning(false);
    onProvisioningChange?.(false);
    if (connected._tag === "Failure") {
      if (!isAtomCommandInterrupted(connected)) {
        const message = formatFailure(squashAtomCommandFailure(connected));
        onErrorChange(
          `The sandbox is running, but pairing failed: ${message}. Add ${sandbox.httpBaseUrl} manually with pairing code ${sandbox.pairingCode}.`,
        );
      }
      return;
    }

    setApiKey("");
    setLabel("");
    setRepositoryUrl("");
    onDone();
    toastManager.add({
      type: "success",
      title: "Sandbox environment added",
      description: `${sandbox.label} is running T3 Code and will reconnect on app startup.`,
    });
  };

  return (
    <div className="space-y-4">
      {providersQuery.error ? (
        <Alert variant="error">
          <AlertDescription>{providersQuery.error}</AlertDescription>
        </Alert>
      ) : null}
      {providers.length === 0 && providersQuery.isPending ? (
        <p className="text-xs text-muted-foreground">Loading sandbox providers…</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {providers.map((candidate) => {
            const selected = candidate.kind === provider?.kind;
            return (
              <EnvironmentModeCard
                key={candidate.kind}
                selected={selected}
                disabled={isProvisioning}
                title={candidate.label}
                description={candidate.detail}
                icon={<SandboxProviderLogo kind={candidate.kind} />}
                badge={
                  candidate.configured ? (
                    <span className="rounded-full border border-border/70 px-1.5 py-0.5 text-2xs text-muted-foreground">
                      Key saved
                    </span>
                  ) : null
                }
                onClick={() => {
                  setSelectedKind(candidate.kind);
                  setSize("");
                  setTemplateName("");
                  // Never carry one provider's key into another provider's replacement field.
                  setApiKey("");
                  setSettingsDraft({});
                  setCredentialEnvironment("");
                  setAllowCredentials(false);
                }}
              />
            );
          })}
        </div>
      )}

      {provider === undefined ? null : (
        <>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
            <label className="block">
              <span className="mb-1.5 flex items-center justify-between gap-2 text-xs font-medium text-foreground">
                {provider.apiKeyLabel}
                <a
                  href={provider.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-2xs font-normal text-muted-foreground hover:text-foreground"
                >
                  Get a key
                  <ExternalLinkIcon aria-hidden className="size-3" />
                </a>
              </span>
              <Input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  provider.configured
                    ? "Saved. Enter a new key to replace it."
                    : provider.apiKeyPlaceholder
                }
                disabled={isProvisioning}
                spellCheck={false}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">Machine</span>
              <Select
                value={selectedSize}
                disabled={isProvisioning || template !== undefined}
                onValueChange={(value) => {
                  if (value !== null) setSize(value);
                }}
              >
                <SelectTrigger aria-label="Sandbox machine size" size="default">
                  <SelectValue>
                    {provider.sizes.find((candidate) => candidate.id === selectedSize)?.label ??
                      (template === undefined ? "Choose a size" : "Template's size")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {provider.sizes.map((candidate) => {
                    const availability = sizeAvailability.get(candidate.id);
                    const unavailable = availability !== undefined && !availability.available;
                    return (
                      <SelectItem key={candidate.id} value={candidate.id} disabled={unavailable}>
                        {candidate.label}, {candidate.detail}
                        {unavailable
                          ? `. ${availability.reason ?? "Not available on this plan."}`
                          : ""}
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
            </label>
          </div>
          {settingsFields.length === 0 ? null : (
            <div className="grid gap-3 sm:grid-cols-2">
              {settingsFields.map((field) => (
                <label key={field.id} className="block">
                  <span className="mb-1.5 block text-xs font-medium text-foreground">
                    {field.label}
                    {field.optional ? (
                      <span className="font-normal text-muted-foreground"> (optional)</span>
                    ) : null}
                  </span>
                  <Input
                    value={settingValue(field.id)}
                    onChange={(event) =>
                      setSettingsDraft({ ...settingsDraft, [field.id]: event.target.value })
                    }
                    placeholder={field.placeholder}
                    disabled={isProvisioning}
                    spellCheck={false}
                  />
                </label>
              ))}
            </div>
          )}
          {startCheck.limits === null ? null : (
            <SandboxQuotaLine limits={startCheck.limits} defaultTtlMinutes={DEFAULT_TTL_MINUTES} />
          )}

          {templates.templates.length === 0 ? null : (
            <div className="space-y-1.5">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-foreground">Start from</span>
                <Select
                  value={template?.name ?? FRESH_MACHINE}
                  disabled={isProvisioning}
                  onValueChange={(value) => {
                    if (value !== null) setTemplateName(value === FRESH_MACHINE ? "" : value);
                  }}
                >
                  <SelectTrigger aria-label="Start the sandbox from" size="default">
                    <SelectValue>{template?.name ?? "Fresh machine"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={FRESH_MACHINE}>Fresh machine</SelectItem>
                    {templates.templates.map((candidate) => (
                      <SelectItem key={candidate.name} value={candidate.name}>
                        {candidate.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              {template === undefined ? null : (
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  Starts with the template's tools, repositories, and files, at the size it was
                  saved from. T3 Code sets up as a new environment.
                </p>
              )}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">Name</span>
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={`${provider.label} sandbox`}
                disabled={isProvisioning}
                spellCheck={false}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Repository to clone{" "}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </span>
              <Input
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
                placeholder="https://github.com/owner/repo"
                disabled={isProvisioning}
                spellCheck={false}
              />
            </label>
          </div>

          {provider.capabilities.credentialEnvironments ? (
            <div className="space-y-2">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-foreground">
                  {provider.label} environment
                </span>
                <Select
                  value={
                    credentialEnvironment === "" ? NO_CREDENTIAL_ENVIRONMENT : credentialEnvironment
                  }
                  disabled={isProvisioning || environmentsQuery.isPending}
                  onValueChange={(value) => {
                    if (value === null) return;
                    setCredentialEnvironment(value === NO_CREDENTIAL_ENVIRONMENT ? "" : value);
                    setAllowCredentials(false);
                  }}
                >
                  <SelectTrigger
                    aria-label={`${provider.label} credential environment`}
                    size="default"
                  >
                    <SelectValue>
                      {selectedCredentialEnvironment?.name ?? "No credentials (recommended)"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={NO_CREDENTIAL_ENVIRONMENT}>
                      No credentials (recommended)
                    </SelectItem>
                    {credentialEnvironments.map((candidate) => (
                      <SelectItem key={candidate.name} value={candidate.name}>
                        {candidate.name}
                        {candidate.safeForThirdParties ? " (safe for third parties)" : ""}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              <p className="text-2xs leading-relaxed text-muted-foreground">
                {selectedCredentialEnvironment === undefined
                  ? `No ${provider.label} secrets, GitHub token, or agent logins reach the sandbox.`
                  : describeCredentialEnvironment(selectedCredentialEnvironment, provider.label)}
              </p>
              {environmentsQuery.error ? (
                <p className="text-2xs text-destructive">
                  Could not list {provider.label} environments. The sandbox will start with no
                  credentials.
                </p>
              ) : null}
              {passesCredentials ? (
                <Alert variant="error">
                  <AlertDescription>
                    <label className="flex cursor-pointer items-start gap-2">
                      <Checkbox
                        className="mt-0.5"
                        checked={allowCredentials}
                        disabled={isProvisioning}
                        onCheckedChange={(checked) => setAllowCredentials(checked === true)}
                      />
                      <span>
                        I understand this sandbox will receive the credentials listed above. Prefer
                        a {provider.label} environment that is safe for third parties or leaves out
                        secrets.
                      </span>
                    </label>
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
          ) : null}

          <p className="text-2xs leading-relaxed text-muted-foreground">
            {credentialEnvironment === ""
              ? `The sandbox starts without your ${provider.label} account's secrets, GitHub token, or agent logins.`
              : `The sandbox receives only what this ${provider.label} environment passes.`}{" "}
            The server creates the machine, installs T3 Code, and pairs it. This usually takes one
            to three minutes and bills the provider account that owns the key.
          </p>

          {!canWriteSettings ? (
            <Alert variant="error">
              <AlertDescription>
                This connection cannot change settings on the environment that would provision the
                sandbox.
              </AlertDescription>
            </Alert>
          ) : null}
          {startCheck.blocked === null ? null : (
            <SandboxStartBlocked
              reason={startCheck.blocked.reason}
              billingUrl={startCheck.limits?.billingUrl}
            />
          )}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          {startCheck.isConfirming && !isProvisioning ? (
            <SandboxStartConfirmation
              warnings={startCheck.assessment?.warnings ?? []}
              confirmLabel="Create anyway"
              onConfirm={() => void handleCreate()}
              onCancel={startCheck.cancel}
            />
          ) : (
            <Button
              variant="outline"
              className="w-full"
              disabled={disabled}
              onClick={() =>
                startCheck.needsConfirmation ? startCheck.confirm() : void handleCreate()
              }
            >
              {isProvisioning ? (
                <Spinner className="size-3.5" />
              ) : (
                <PlusIcon className="size-3.5" />
              )}
              {isProvisioning ? "Provisioning sandbox…" : `Create ${provider.label} sandbox`}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
