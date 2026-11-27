import { sourceControlInstallHintText } from "@t3tools/client-runtime/contract-labels";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ScopedThreadRef,
  SourceControlCloneProtocol,
  SourceControlProviderDiscoveryItem,
  SourceControlProviderKind,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryVisibility,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { CheckIcon, ChevronDownIcon, GlobeIcon, LockIcon } from "lucide-react";
import { useId, useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { m, type MessageResolver } from "~/i18n/messages";
import { useSourceControlPublishRepositoryAction } from "~/state/sourceControlActions";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { sourceControlIcon } from "~/sourceControlPresentation";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  isSourceControlProviderOffered,
  type OfferedSourceControlProviders,
} from "@t3tools/client-runtime/operations/projects";
import { DialogSubmitKbd, isDialogSubmitShortcut } from "./DialogSubmitShortcut";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Spinner } from "./ui/spinner";
import { Toggle, ToggleGroup } from "./ui/toggle-group";
import { SharedTooltipTrigger } from "./ui/shared-tooltip";

/** Tile order and the short names narrow tiles use; hosts not listed follow in registry order. */
const TILE_ORDER: ReadonlyArray<string> = [
  "github",
  "gitlab",
  "bitbucket",
  "forgejo",
  "azure-devops",
  "gitcafe",
];
const TILE_LABELS: Readonly<Record<string, string>> = {
  forgejo: "Forgejo",
  "azure-devops": "Azure",
};
const tileRank = (kind: string) => {
  const index = TILE_ORDER.indexOf(kind);
  return index === -1 ? TILE_ORDER.length : index;
};

/** Every built-in host. `ownerLabel` names the first path segment the way each host does. */
const PUBLISH_PROVIDER_OPTIONS = sourceControlClients.definitions
  .toSorted((left, right) => tileRank(left.kind) - tileRank(right.kind))
  .map((definition) => {
    const ownerSegment = definition.repositoryPathHint.split("/")[0] ?? "owner";
    return {
      value: definition.kind,
      label: definition.pickerLabel,
      tileLabel: TILE_LABELS[definition.kind],
      ownerLabel: ownerSegment.charAt(0).toUpperCase() + ownerSegment.slice(1),
      Icon: sourceControlIcon(definition),
    };
  });

type PublishProviderOption = (typeof PUBLISH_PROVIDER_OPTIONS)[number];

interface PublishProviderReadiness {
  readonly ready: boolean;
  readonly hint: string | null;
}

function getPublishProviderReadiness(
  input: {
    provider: SourceControlProviderKind;
    sourceControlProviders: ReadonlyArray<SourceControlProviderDiscoveryItem>;
  },
  resolve: MessageResolver = m,
): PublishProviderReadiness {
  const discovered = input.sourceControlProviders.find(
    (provider) => provider.kind === input.provider,
  );
  if (!discovered) {
    return {
      ready: false,
      hint: resolve(
        msg("Provider status unavailable. Open Settings -> Source control & issues and rescan."),
      ),
    };
  }
  if (discovered.status !== "available") {
    return { ready: false, hint: sourceControlInstallHintText(discovered.installHint, resolve) };
  }
  if (discovered.auth.status === "unauthenticated") {
    return {
      ready: false,
      hint:
        Option.getOrNull(discovered.auth.detail) ??
        resolve(
          msg(
            "{provider} is not authenticated. Open Settings -> Source control & issues for setup guidance.",
            {
              provider: discovered.label,
            },
          ),
        ),
    };
  }
  return { ready: true, hint: null };
}

const VISIBILITY_HINTS = {
  private: { Icon: LockIcon, text: msg("Only invited people can see it.") },
  public: { Icon: GlobeIcon, text: msg("Anyone on the web can see it.") },
} as const satisfies Record<
  SourceControlRepositoryVisibility,
  { readonly Icon: typeof LockIcon; readonly text: string }
>;

/** Provider tiles; one that still needs setup opens Source control settings instead. */
function PublishProviderTile(props: {
  readonly option: PublishProviderOption;
  readonly readiness: PublishProviderReadiness;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
  readonly onOpenSetup: () => void;
}) {
  const gt = useGT();
  const { option, readiness } = props;
  const tile = (
    <Toggle
      variant="outline"
      size="tile"
      pressed={props.selected}
      aria-label={option.label}
      disabled={props.disabled}
      onClick={readiness.ready ? props.onSelect : props.onOpenSetup}
      className="w-full min-w-0"
    >
      <span
        className={cn(
          "flex min-w-0 flex-col items-center gap-1.5",
          !readiness.ready && "opacity-55",
        )}
      >
        <option.Icon className="size-4 shrink-0" aria-hidden />
        <span className="max-w-full truncate">{option.tileLabel ?? option.label}</span>
      </span>
    </Toggle>
  );
  if (readiness.ready) return tile;
  return (
    <SharedTooltipTrigger
      render={tile}
      label={
        readiness.hint ?? gt("Open Settings -> Source control & issues to configure this provider.")
      }
    />
  );
}

export interface PublishRepositoryDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: ScopedThreadRef["environmentId"] | null;
  /** Thread the dialog was opened from, so the new repository can open beside it. */
  readonly threadRef: ScopedThreadRef | null;
  readonly gitCwd: string;
  readonly offeredProviders: OfferedSourceControlProviders | undefined;
}

/**
 * Creates a repository on a source control host and pushes the current branch to it, on one
 * page: provider, owner and name, visibility, and the remote's protocol.
 */
export function PublishRepositoryDialog(props: PublishRepositoryDialogProps) {
  const gt = useGT();
  const messages = useMessages();
  const openLink = useOpenLink(props.threadRef);
  const navigate = useNavigate();
  const ownerFieldId = useId();
  const nameFieldId = useId();
  const remoteNameFieldId = useId();
  const sourceControlDiscovery = useEnvironmentQuery(
    props.environmentId === null
      ? null
      : sourceControlEnvironment.discovery({ environmentId: props.environmentId, input: {} }),
  );
  const [selectedProvider, setSelectedProvider] = useState<SourceControlProviderKind | null>(null);
  const [ownerOverride, setOwnerOverride] = useState<string | null>(null);
  const [repositoryName, setRepositoryName] = useState("");
  const [visibility, setVisibility] = useState<SourceControlRepositoryVisibility>("private");
  const [remoteName, setRemoteName] = useState("origin");
  const [protocol, setProtocol] = useState<SourceControlCloneProtocol>("ssh");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<SourceControlPublishRepositoryResult | null>(
    null,
  );
  const sourceControlScope = { environmentId: props.environmentId, cwd: props.gitCwd };
  const publishRepositoryAction = useSourceControlPublishRepositoryAction(sourceControlScope);
  const discoveredProviders = sourceControlDiscovery.data?.sourceControlProviders;

  const readinessByProvider = (provider: SourceControlProviderKind) =>
    getPublishProviderReadiness(
      {
        provider,
        sourceControlProviders: discoveredProviders ?? [],
      },
      messages,
    );
  const offeredProviderOptions = PUBLISH_PROVIDER_OPTIONS.filter((option) =>
    isSourceControlProviderOffered(props.offeredProviders, option.value),
  );
  const hasReadyProvider = offeredProviderOptions.some(
    (option) => readinessByProvider(option.value).ready,
  );
  const firstReadyProvider = offeredProviderOptions.find(
    (option) => readinessByProvider(option.value).ready,
  )?.value;
  // The dialog stays mounted, so a host turned off after it was picked must not stay selected.
  const offeredSelection =
    selectedProvider !== null &&
    isSourceControlProviderOffered(props.offeredProviders, selectedProvider)
      ? selectedProvider
      : null;
  const provider =
    offeredSelection !== null && readinessByProvider(offeredSelection).ready
      ? offeredSelection
      : (firstReadyProvider ?? offeredSelection ?? sourceControlClients.get(undefined).kind);
  const providerOption =
    PUBLISH_PROVIDER_OPTIONS.find((option) => option.value === provider) ??
    PUBLISH_PROVIDER_OPTIONS[0]!;
  const providerReady = readinessByProvider(provider).ready;

  const signedInProvider = discoveredProviders?.find((entry) => entry.kind === provider);
  const signedInAccount = signedInProvider ? Option.getOrNull(signedInProvider.auth.account) : null;
  const owner = ownerOverride ?? signedInAccount ?? "";

  const repositoryPath = `${owner.trim()}/${repositoryName.trim()}`;
  const canSubmit =
    publishRepositoryAction.isAllowed &&
    hasReadyProvider &&
    providerReady &&
    !publishRepositoryAction.isPending &&
    owner.trim().length > 0 &&
    repositoryName.trim().length > 0;

  const submit = () => {
    if (!canSubmit) return;
    setPublishError(null);
    void (async () => {
      const result = await publishRepositoryAction.run({
        provider,
        repository: repositoryPath,
        visibility,
        remoteName: remoteName.trim() || "origin",
        protocol,
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setPublishError(thrownErrorMessage(error, m) ?? gt("An error occurred."));
        }
        return;
      }
      setPublishResult(result.value);
    })();
  };

  const handleOpenChange = (open: boolean) => {
    props.onOpenChange(open);
    if (open) return;
    setOwnerOverride(null);
    setRepositoryName("");
    setRemoteName("origin");
    setAdvancedOpen(false);
    setPublishError(null);
    setPublishResult(null);
  };

  const openSourceControlSettings = () => {
    handleOpenChange(false);
    void navigate({ to: "/settings/source-control" });
  };

  const visibilityHint = VISIBILITY_HINTS[visibility];
  const isPending = publishRepositoryAction.isPending;

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogPopup
        className="sm:max-w-150"
        onKeyDown={(event) => {
          if (publishResult || !isDialogSubmitShortcut(event)) return;
          event.preventDefault();
          submit();
        }}
      >
        {publishResult ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {publishResult.status === "pushed"
                  ? gt("Repository published")
                  : gt("Repository created")}
              </DialogTitle>
              <DialogDescription>
                {publishResult.status === "pushed"
                  ? gt("{branch} is now live on {provider}.", {
                      branch: publishResult.branch,
                      provider: providerOption.label,
                    })
                  : gt(
                      'Remote "{remote}" is set up. Make a commit and push it to share your code.',
                      { remote: publishResult.remoteName },
                    )}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex items-center gap-2 rounded-control surface-well px-3 py-2">
                <CheckIcon className="size-3.5 shrink-0 text-success-foreground" aria-hidden />
                <providerOption.Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-meta text-foreground">
                  {publishResult.repository.nameWithOwner}
                </span>
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button
                variant="secondary"
                size="standard"
                onClick={() => {
                  void openLink(publishResult.repository.url).catch(() => undefined);
                }}
              >
                <T>
                  Open on <Var>{providerOption.label}</Var>
                </T>
              </Button>
              <Button size="standard" onClick={() => handleOpenChange(false)}>
                <T context="button, closes the finished publish dialog">Done</T>
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{gt("Publish repository")}</DialogTitle>
              <DialogDescription>
                {gt("Pick where to host it, then point us at a repo to push to.")}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-1.5">
                <Label render={<span />}>
                  <T>Provider</T>
                </Label>
                <div
                  className="grid grid-cols-3 gap-1.5 sm:grid-cols-6"
                  role="group"
                  aria-label={gt("Provider")}
                >
                  {offeredProviderOptions.map((option) => (
                    <PublishProviderTile
                      key={option.value}
                      option={option}
                      readiness={readinessByProvider(option.value)}
                      selected={
                        provider === option.value && readinessByProvider(option.value).ready
                      }
                      disabled={isPending}
                      onSelect={() => {
                        setSelectedProvider(option.value);
                        setOwnerOverride(null);
                      }}
                      onOpenSetup={openSourceControlSettings}
                    />
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor={ownerFieldId}>{providerOption.ownerLabel}</Label>
                  <Input
                    id={ownerFieldId}
                    size="sm"
                    value={owner}
                    onChange={(event) => setOwnerOverride(event.target.value)}
                    placeholder={gt("owner", { $context: "placeholder, repository owner" })}
                    disabled={isPending}
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor={nameFieldId}>
                    <T>Repository</T>
                  </Label>
                  <Input
                    id={nameFieldId}
                    size="sm"
                    value={repositoryName}
                    onChange={(event) => setRepositoryName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || isDialogSubmitShortcut(event)) return;
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                      event.preventDefault();
                      submit();
                    }}
                    placeholder={gt("repository", { $context: "placeholder, repository name" })}
                    disabled={isPending}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label render={<span />}>
                    <T>Visibility</T>
                  </Label>
                  <ToggleGroup
                    className="w-full"
                    aria-label={gt("Visibility")}
                    value={[visibility]}
                    onValueChange={(next) => {
                      const value = next[0];
                      if (value === "private" || value === "public") setVisibility(value);
                    }}
                    disabled={isPending}
                  >
                    <Toggle className="flex-1" value="private">
                      {gt("Private")}
                    </Toggle>
                    <Toggle className="flex-1" value="public">
                      {gt("Public")}
                    </Toggle>
                  </ToggleGroup>
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label render={<span />}>
                    <T context="git remote">Remote</T>
                  </Label>
                  <ToggleGroup
                    className="w-full"
                    aria-label={gt("Remote protocol")}
                    value={[protocol]}
                    onValueChange={(next) => {
                      const value = next[0];
                      if (value === "ssh" || value === "https") setProtocol(value);
                    }}
                    disabled={isPending}
                  >
                    <Toggle className="flex-1" value="https">
                      HTTPS
                    </Toggle>
                    <Toggle className="flex-1" value="ssh">
                      SSH
                    </Toggle>
                  </ToggleGroup>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <p className="flex min-w-0 items-center gap-2 text-body text-muted-foreground">
                  <visibilityHint.Icon className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{messages(visibilityHint.text)}</span>
                </p>
                <Button
                  variant="ghost-muted"
                  size="xs"
                  onClick={() => setAdvancedOpen((open) => !open)}
                  aria-expanded={advancedOpen}
                >
                  <T>Remote name</T>
                  <ChevronDownIcon
                    className={cn("size-3.5 transition-transform", !advancedOpen && "-rotate-90")}
                    aria-hidden
                  />
                </Button>
              </div>
              {advancedOpen ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={remoteNameFieldId}>
                    <T>Remote name</T>
                  </Label>
                  <Input
                    id={remoteNameFieldId}
                    size="sm"
                    value={remoteName}
                    onChange={(event) => setRemoteName(event.target.value)}
                    placeholder="origin"
                    disabled={isPending}
                  />
                </div>
              ) : null}

              {publishError && !isPending ? (
                <Alert variant="error">
                  <AlertTitle>
                    <T>Publish failed</T>
                  </AlertTitle>
                  <AlertDescription>{publishError}</AlertDescription>
                </Alert>
              ) : null}
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button
                variant="secondary"
                size="standard"
                disabled={isPending}
                onClick={() => handleOpenChange(false)}
              >
                <T>Cancel</T>
              </Button>
              <Button size="standard" disabled={!canSubmit} onClick={submit}>
                {isPending ? (
                  <>
                    <Spinner size="sm" aria-hidden />
                    <T>Publishing...</T>
                  </>
                ) : (
                  <>
                    <T context="verb">Publish</T>
                    <DialogSubmitKbd />
                  </>
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
