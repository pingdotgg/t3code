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
import { CheckIcon, ChevronDownIcon, GlobeIcon, LockIcon } from "lucide-react";
import { useId, useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { useSourceControlPublishRepositoryAction } from "~/state/sourceControlActions";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { sourceControlIcon } from "~/sourceControlPresentation";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { DialogSubmitKbd, isDialogSubmitShortcut } from "./DialogSubmitShortcut";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

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

function getPublishProviderReadiness(input: {
  provider: SourceControlProviderKind;
  sourceControlProviders: ReadonlyArray<SourceControlProviderDiscoveryItem>;
}): PublishProviderReadiness {
  const discovered = input.sourceControlProviders.find(
    (provider) => provider.kind === input.provider,
  );
  if (!discovered) {
    return {
      ready: false,
      hint: "Provider status unavailable. Open Settings -> Source control and rescan.",
    };
  }
  if (discovered.status !== "available") {
    return { ready: false, hint: discovered.installHint };
  }
  if (discovered.auth.status === "unauthenticated") {
    return {
      ready: false,
      hint:
        Option.getOrNull(discovered.auth.detail) ??
        `${discovered.label} is not authenticated. Open Settings -> Source control for setup guidance.`,
    };
  }
  return { ready: true, hint: null };
}

const VISIBILITY_HINTS = {
  private: { Icon: LockIcon, text: "Only invited people can see it." },
  public: { Icon: GlobeIcon, text: "Anyone on the web can see it." },
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
    <Tooltip>
      <TooltipTrigger render={tile} />
      <TooltipPopup side="top">
        {readiness.hint ?? "Open Settings -> Source control to configure this provider."}
      </TooltipPopup>
    </Tooltip>
  );
}

export interface PublishRepositoryDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: ScopedThreadRef["environmentId"] | null;
  /** Thread the dialog was opened from, so the new repository can open beside it. */
  readonly threadRef: ScopedThreadRef | null;
  readonly gitCwd: string;
}

/**
 * Creates a repository on a source control host and pushes the current branch to it, on one
 * page: provider, owner and name, visibility, and the remote's protocol.
 */
export function PublishRepositoryDialog(props: PublishRepositoryDialogProps) {
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
    getPublishProviderReadiness({
      provider,
      sourceControlProviders: discoveredProviders ?? [],
    });
  const firstReadyProvider = PUBLISH_PROVIDER_OPTIONS.find(
    (option) => readinessByProvider(option.value).ready,
  )?.value;
  const provider =
    selectedProvider !== null && readinessByProvider(selectedProvider).ready
      ? selectedProvider
      : (firstReadyProvider ?? selectedProvider ?? sourceControlClients.get(undefined).kind);
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
          setPublishError(error instanceof Error ? error.message : "An error occurred.");
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
        className="sm:max-w-115"
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
                {publishResult.status === "pushed" ? "Repository published" : "Repository created"}
              </DialogTitle>
              <DialogDescription>
                {publishResult.status === "pushed"
                  ? `${publishResult.branch} is now live on ${providerOption.label}.`
                  : `Remote "${publishResult.remoteName}" is set up. Make a commit and push it to share your code.`}
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
                Open on {providerOption.label}
              </Button>
              <Button size="standard" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Publish repository</DialogTitle>
              <DialogDescription>
                Pick where to host it, then point us at a repo to push to.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-1.5">
                <Label render={<span />}>Provider</Label>
                <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Provider">
                  {PUBLISH_PROVIDER_OPTIONS.map((option) => (
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
                    placeholder="owner"
                    disabled={isPending}
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor={nameFieldId}>Repository</Label>
                  <Input
                    id={nameFieldId}
                    size="sm"
                    value={repositoryName}
                    onChange={(event) => setRepositoryName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || isDialogSubmitShortcut(event)) return;
                      event.preventDefault();
                      submit();
                    }}
                    placeholder="repository"
                    disabled={isPending}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label render={<span />}>Visibility</Label>
                  <ToggleGroup
                    className="w-full"
                    aria-label="Visibility"
                    value={[visibility]}
                    onValueChange={(next) => {
                      const value = next[0];
                      if (value === "private" || value === "public") setVisibility(value);
                    }}
                    disabled={isPending}
                  >
                    <Toggle className="flex-1" value="private">
                      Private
                    </Toggle>
                    <Toggle className="flex-1" value="public">
                      Public
                    </Toggle>
                  </ToggleGroup>
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label render={<span />}>Remote</Label>
                  <ToggleGroup
                    className="w-full"
                    aria-label="Remote protocol"
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
                  <span className="truncate">{visibilityHint.text}</span>
                </p>
                <Button
                  variant="ghost-muted"
                  size="xs"
                  onClick={() => setAdvancedOpen((open) => !open)}
                  aria-expanded={advancedOpen}
                >
                  Remote name
                  <ChevronDownIcon
                    className={cn("size-3.5 transition-transform", !advancedOpen && "-rotate-90")}
                    aria-hidden
                  />
                </Button>
              </div>
              {advancedOpen ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={remoteNameFieldId}>Remote name</Label>
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
                <div
                  role="alert"
                  className="rounded-control border border-error/40 bg-error/10 px-3 py-2 text-meta text-destructive-foreground"
                >
                  <p className="text-label">Publish failed</p>
                  <p className="mt-0.5 text-error-foreground">{publishError}</p>
                </div>
              ) : null}
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button
                variant="secondary"
                size="standard"
                disabled={isPending}
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
              <Button size="standard" disabled={!canSubmit} onClick={submit}>
                {isPending ? (
                  <>
                    <Spinner size="sm" aria-hidden />
                    Publishing...
                  </>
                ) : (
                  <>
                    Publish
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
