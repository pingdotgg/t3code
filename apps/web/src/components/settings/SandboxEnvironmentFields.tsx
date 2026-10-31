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
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { connectPairing as connectPairingAtom } from "~/connection/onboarding";
import { readEnvironmentScope } from "~/state/session";
import { AuthSettingsWriteScope } from "@t3tools/contracts";

const EMPTY_PROVIDERS: ReadonlyArray<SandboxProviderInfo> = [];
const EMPTY_CREDENTIAL_ENVIRONMENTS: ReadonlyArray<SandboxCredentialEnvironment> = [];
const NO_CREDENTIAL_ENVIRONMENT = "__none__";

const describeCredentialEnvironment = (environment: SandboxCredentialEnvironment): string => {
  if (environment.safeForThirdParties) {
    return environment.proxyAiCredentials
      ? "Passes nothing. AI calls go through Boat's proxy, so real keys stay outside the sandbox."
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
  const [label, setLabel] = useState("");
  const [size, setSize] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [credentialEnvironment, setCredentialEnvironment] = useState("");
  const [allowCredentials, setAllowCredentials] = useState(false);
  const [isProvisioning, setIsProvisioning] = useState(false);
  const providers = providersQuery.data?.providers ?? EMPTY_PROVIDERS;
  const provider = providers.find((candidate) => candidate.kind === selectedKind) ?? providers[0];
  const selectedSize = size === "" ? (provider ? providerDefaultSize(provider) : "") : size;
  const environmentsQuery = useEnvironmentQuery(
    provider?.kind === "boat"
      ? serverEnvironment.sandboxesEnvironments({
          environmentId,
          input: { provider: "boat" },
        })
      : null,
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
    (passesCredentials && !allowCredentials);

  const handleCreate = async () => {
    if (provider === undefined) return;
    setIsProvisioning(true);
    onProvisioningChange?.(true);
    onErrorChange(null);
    const created = await createSandbox({
      environmentId,
      input: {
        provider: provider.kind,
        ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
        ...(label.trim() === "" ? {} : { label: label.trim() }),
        ...(selectedSize === "" ? {} : { size: selectedSize }),
        ...(repositoryUrl.trim() === "" ? {} : { repositoryUrl: repositoryUrl.trim() }),
        ...(credentialEnvironment === ""
          ? {}
          : { environment: credentialEnvironment, allowCredentials: true }),
      },
    });
    if (created._tag === "Failure") {
      if (!isAtomCommandInterrupted(created)) {
        const message = formatFailure(squashAtomCommandFailure(created));
        onErrorChange(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not create sandbox",
            description: message,
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
                  // Never carry one provider's key into another provider's replacement field.
                  setApiKey("");
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
                disabled={isProvisioning}
                onValueChange={(value) => {
                  if (value !== null) setSize(value);
                }}
              >
                <SelectTrigger aria-label="Sandbox machine size" size="default">
                  <SelectValue>
                    {provider.sizes.find((candidate) => candidate.id === selectedSize)?.label ??
                      "Choose a size"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {provider.sizes.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.label}, {candidate.detail}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
          </div>

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

          {provider.kind === "boat" ? (
            <div className="space-y-2">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-foreground">
                  Boat environment
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
                  <SelectTrigger aria-label="Boat credential environment" size="default">
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
                  ? "No Boat secrets, GitHub token, or agent logins reach the sandbox."
                  : describeCredentialEnvironment(selectedCredentialEnvironment)}
              </p>
              {environmentsQuery.error ? (
                <p className="text-2xs text-destructive">
                  Could not list Boat environments. The sandbox will start with no credentials.
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
                        a Boat environment that is safe for third parties or leaves out secrets.
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
          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <Button
            variant="outline"
            className="w-full"
            disabled={disabled}
            onClick={() => void handleCreate()}
          >
            {isProvisioning ? <Spinner className="size-3.5" /> : <PlusIcon className="size-3.5" />}
            {isProvisioning ? "Provisioning sandbox…" : `Create ${provider.label} sandbox`}
          </Button>
        </>
      )}
    </div>
  );
}
