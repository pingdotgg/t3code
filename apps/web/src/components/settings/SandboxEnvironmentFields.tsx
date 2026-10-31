import { BoxIcon, ExternalLinkIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import type { EnvironmentId, SandboxCreateResult, SandboxProviderInfo } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { cn } from "../../lib/utils";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { connectPairing as connectPairingAtom } from "~/connection/onboarding";
import { readEnvironmentScope } from "~/state/session";
import { AuthSettingsWriteScope } from "@t3tools/contracts";

const EMPTY_PROVIDERS: ReadonlyArray<SandboxProviderInfo> = [];

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
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly error: string | null;
  readonly onErrorChange: (error: string | null) => void;
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
  const [isProvisioning, setIsProvisioning] = useState(false);
  const providers = providersQuery.data?.providers ?? EMPTY_PROVIDERS;
  const provider = providers.find((candidate) => candidate.kind === selectedKind) ?? providers[0];
  const selectedSize = size === "" ? (provider ? providerDefaultSize(provider) : "") : size;
  const canWriteSettings = readEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const disabled = isProvisioning || provider === undefined || !canWriteSettings;

  const handleCreate = async () => {
    if (provider === undefined) return;
    setIsProvisioning(true);
    onErrorChange(null);
    const created = await createSandbox({
      environmentId,
      input: {
        provider: provider.kind,
        ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
        ...(label.trim() === "" ? {} : { label: label.trim() }),
        ...(selectedSize === "" ? {} : { size: selectedSize }),
        ...(repositoryUrl.trim() === "" ? {} : { repositoryUrl: repositoryUrl.trim() }),
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
      return;
    }

    const sandbox = created.value as SandboxCreateResult;
    const connected = await connectPairing({
      host: sandbox.httpBaseUrl,
      pairingCode: sandbox.pairingCode,
    });
    setIsProvisioning(false);
    if (connected._tag === "Failure") {
      if (!isAtomCommandInterrupted(connected)) {
        const message = formatFailure(squashAtomCommandFailure(connected));
        onErrorChange(
          `The sandbox is running, but pairing failed: ${message}. Add ${sandbox.httpBaseUrl} manually with the code from the sandbox.`,
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
              <button
                key={candidate.kind}
                type="button"
                aria-pressed={selected}
                className={cn(
                  "group flex min-h-24 items-start gap-3 rounded-lg border p-4 text-left",
                  selected
                    ? "border-primary/50 bg-primary/5"
                    : "border-border/60 hover:bg-muted/40",
                )}
                disabled={isProvisioning}
                onClick={() => {
                  setSelectedKind(candidate.kind);
                  setSize("");
                }}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
                    selected
                      ? "border-primary/30 bg-primary/10 text-primary"
                      : "border-border/70 bg-background text-muted-foreground group-hover:text-foreground",
                  )}
                >
                  <BoxIcon aria-hidden className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    {candidate.label}
                    {candidate.configured ? (
                      <span className="rounded-full border border-border/70 px-1.5 py-0.5 text-2xs text-muted-foreground">
                        Key saved
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                    {candidate.detail}
                  </span>
                </span>
              </button>
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

          <p className="text-2xs leading-relaxed text-muted-foreground">
            The sandbox starts without your Boat account's secrets, GitHub token, or agent logins.
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
