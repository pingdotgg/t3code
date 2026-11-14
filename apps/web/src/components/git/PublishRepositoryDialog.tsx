
import { Button } from "~/components/ui/button";
import { CheckIcon, ChevronDownIcon, LockIcon, GlobeIcon } from "lucide-react";
import { Dialog } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import * as Option from "effect/Option";
import { RadioGroup } from "~/components/ui/radio-group";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { SourceControlProviderKind, type ScopedThreadRef } from "@t3tools/contracts";
import type { SourceControlCloneProtocol, SourceControlProviderDiscoveryItem, SourceControlPublishRepositoryResult, SourceControlRepositoryVisibility } from "@t3tools/contracts";
import { Spinner } from "~/components/ui/spinner";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { WizardPopup, WizardHeader, WizardSteps, WizardPanel, WizardFooter } from "../ui/wizard";
import { cn } from "~/lib/utils";
import { flushSync } from "react-dom";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { useEnvironmentQuery } from "~/state/query";
import { useNavigate } from "@tanstack/react-router";
import { useOpenLink } from "~/browser/useOpenLink";
import { useSourceControlPublishRepositoryAction } from "../../state/sourceControlActions";
import { useState } from "react";
import { sourceControlIcon } from "~/sourceControlPresentation";

const PUBLISH_PROVIDER_OPTIONS = sourceControlClients.definitions.map((definition) => ({
  value: definition.kind,
  label: definition.pickerLabel,
  description: definition.publishDescription,
  pathPlaceholder: definition.repositoryPathHint,
  definition,
  Icon: sourceControlIcon(definition),
}));

function publishProviderOption(provider: SourceControlProviderKind) {
  return (
    PUBLISH_PROVIDER_OPTIONS.find((option) => option.value === provider) ??
    PUBLISH_PROVIDER_OPTIONS[0]!
  );
}

function getPublishProviderReadiness(input: {
  provider: SourceControlProviderKind;
  sourceControlProviders: ReadonlyArray<SourceControlProviderDiscoveryItem>;
}): { readonly ready: boolean; readonly hint: string | null } {
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

interface PublishRepositoryDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: ScopedThreadRef["environmentId"] | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly gitCwd: string;
}

export function PublishRepositoryDialog(props: PublishRepositoryDialogProps) {
  const openLink = useOpenLink(props.threadRef);
  const navigate = useNavigate();
  const sourceControlDiscovery = useEnvironmentQuery(
    props.environmentId === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId: props.environmentId,
          input: {},
        }),
  );
  const [selectedPublishProvider, setSelectedPublishProvider] =
    useState<SourceControlProviderKind | null>(null);
  const [publishRepositoryOverride, setPublishRepositoryOverride] = useState<string | null>(null);
  const [publishVisibility, setPublishVisibility] =
    useState<SourceControlRepositoryVisibility>("private");
  const [publishRemoteName, setPublishRemoteName] = useState("origin");
  const [publishProtocol, setPublishProtocol] = useState<SourceControlCloneProtocol>("ssh");
  const [publishWizardStep, setPublishWizardStep] = useState(0);
  const [publishAdvancedOpen, setPublishAdvancedOpen] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<SourceControlPublishRepositoryResult | null>(
    null,
  );
  const sourceControlScope = {
    environmentId: props.environmentId,
    cwd: props.gitCwd,
  };
  const publishRepositoryAction = useSourceControlPublishRepositoryAction(sourceControlScope);
  const publishAccountByProvider = new Map<string, string | null>();
  for (const provider of sourceControlDiscovery.data?.sourceControlProviders ?? []) {
    publishAccountByProvider.set(provider.kind, Option.getOrNull(provider.auth.account));
  }
  const publishSourceControlProviders = sourceControlDiscovery.data?.sourceControlProviders ?? [];
  const publishReadinessByProvider = new Map(
    PUBLISH_PROVIDER_OPTIONS.map((option) => [
      option.value,
      getPublishProviderReadiness({
        provider: option.value,
        sourceControlProviders: publishSourceControlProviders,
      }),
    ]),
  );
  const publishProviderReadiness = (provider: SourceControlProviderKind) =>
    publishReadinessByProvider.get(provider) ?? { ready: false, hint: null };
  const hasReadyPublishProvider = PUBLISH_PROVIDER_OPTIONS.some(
    (option) => publishProviderReadiness(option.value).ready,
  );
  const sortedPublishProviderOptions = PUBLISH_PROVIDER_OPTIONS.toSorted((left, right) => {
    const leftReady = publishProviderReadiness(left.value).ready;
    const rightReady = publishProviderReadiness(right.value).ready;
    if (leftReady !== rightReady) {
      return leftReady ? -1 : 1;
    }
    return left.label.localeCompare(right.label);
  });
  const firstReadyPublishProvider = sortedPublishProviderOptions.find(
    (option) => publishProviderReadiness(option.value).ready,
  )?.value;
  const publishProvider =
    selectedPublishProvider !== null && publishProviderReadiness(selectedPublishProvider).ready
      ? selectedPublishProvider
      : (firstReadyPublishProvider ??
        selectedPublishProvider ??
        sourceControlClients.get(undefined).kind);
  const selectedPublishProviderReadiness = publishProviderReadiness(publishProvider);
  const publishAccount = publishAccountByProvider.get(publishProvider) ?? null;
  const publishRepositoryPrefill = publishAccount ? `${publishAccount}/` : "";
  const publishRepository = publishRepositoryOverride ?? publishRepositoryPrefill;
  const currentPublishProvider = publishProviderOption(publishProvider);
  const publishHost = currentPublishProvider.definition.publishHost(
    Option.getOrNull(
      sourceControlDiscovery.data?.sourceControlProviders.find(
        (provider) => provider.kind === publishProvider,
      )?.auth.host ?? Option.none(),
    ),
  );
  const publishPathPlaceholder = currentPublishProvider.pathPlaceholder;
  const publishProviderLabel = currentPublishProvider.label;
  const publishWizardSteps = ["Provider", "Repository", "Summary"] as const;
  const publishWizardStepSummaries = [
    publishProviderLabel,
    publishResult?.repository.nameWithOwner ?? null,
    null,
  ] as const;

  const publishRepositoryParts = publishRepository.trim().split("/");
  const publishRepositoryOwner = publishRepositoryParts[0]?.trim() ?? "";
  const publishRepositoryName = publishRepositoryParts.slice(1).join("/").trim();
  const canSubmitPublishRepository =
    publishRepositoryAction.isAllowed &&
    selectedPublishProviderReadiness.ready &&
    !publishRepositoryAction.isPending &&
    publishRepositoryOwner.length > 0 &&
    publishRepositoryName.length > 0;

  const submitPublishRepository = () => {
    if (!canSubmitPublishRepository) {
      return;
    }

    setPublishError(null);

    void (async () => {
      const result = await publishRepositoryAction.run({
        provider: publishProvider,
        repository: publishRepository.trim(),
        visibility: publishVisibility,
        remoteName: publishRemoteName.trim() || "origin",
        protocol: publishProtocol,
      });

      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setPublishError(error instanceof Error ? error.message : "An error occurred.");
        }
        return;
      }

      flushSync(() => {
        setPublishResult(result.value);
        setPublishWizardStep(2);
      });
    })();
  };

  const resetState = () => {
    setPublishRemoteName("origin");
    setPublishRepositoryOverride(null);
    setPublishWizardStep(0);
    setPublishAdvancedOpen(false);
    setPublishError(null);
    setPublishResult(null);
  };

  const handleOpenChange = (open: boolean) => {
    props.onOpenChange(open);
    if (!open) {
      resetState();
    }
  };

  const openSourceControlSettings = () => {
    handleOpenChange(false);
    void navigate({ to: "/settings/source-control" });
  };

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <WizardPopup>
        <WizardHeader
          title="Publish repository"
          description="Pick where to host it, then point us at a repo to push to."
        >
          <WizardSteps
            steps={publishWizardSteps}
            currentStep={publishWizardStep}
            summaries={publishWizardStepSummaries}
            showSummaries
            isStepDisabled={(index) =>
              publishWizardStep === 2 ||
              index >= publishWizardSteps.length - 1 ||
              index > publishWizardStep
            }
            onStepChange={setPublishWizardStep}
          />
        </WizardHeader>

        <WizardPanel>
          <div className={cn("space-y-2", publishWizardStep !== 0 && "hidden")}>
            <span id="publish-provider-cards-label" className="text-xs font-medium text-foreground">
              Provider
            </span>
            <RadioGroup
              value={publishProvider}
              onValueChange={(value) => {
                setSelectedPublishProvider(value as SourceControlProviderKind);
                setPublishRepositoryOverride(null);
              }}
              aria-labelledby="publish-provider-cards-label"
              className="grid grid-cols-2"
            >
              {sortedPublishProviderOptions.map((option) => {
                const readiness = publishProviderReadiness(option.value);
                const isSelected = publishProvider === option.value && readiness.ready;
                if (!readiness.ready) {
                  return (
                    <div
                      key={option.value}
                      className="relative flex cursor-not-allowed items-center gap-3 rounded-lg border border-border bg-background px-3 py-3 text-left opacity-64 dark:border-transparent dark:bg-white/[0.035]"
                    >
                      <option.Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                        {option.label}
                      </span>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="warning-outline"
                              size="micro"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                openSourceControlSettings();
                              }}
                            >
                              Setup Required
                            </Button>
                          }
                        />
                        <TooltipPopup side="top" align="end">
                          {readiness.hint ??
                            "Open Settings -> Source control to configure this provider."}
                        </TooltipPopup>
                      </Tooltip>
                    </div>
                  );
                }

                return (
                  <RadioPrimitive.Root
                    key={option.value}
                    value={option.value}
                    className={cn(
                      "relative flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-left outline-none transition-[background-color,border-color,box-shadow]",
                      "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                      isSelected
                        ? "border-primary bg-background shadow-sm ring-2 ring-inset ring-primary/35 dark:border-transparent dark:bg-primary/10 dark:shadow-none dark:ring-1 dark:ring-primary/30"
                        : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50 dark:border-transparent dark:bg-white/[0.035] dark:hover:bg-accent",
                    )}
                  >
                    <option.Icon className="size-5 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {option.label}
                    </span>
                  </RadioPrimitive.Root>
                );
              })}
            </RadioGroup>
          </div>

          <div className={cn("space-y-5", publishWizardStep !== 1 && "hidden")}>
            <div className="space-y-2">
              <label
                htmlFor="publish-repository-path"
                className="text-xs font-medium text-foreground"
              >
                Repository
              </label>
              <div className="flex items-stretch overflow-hidden rounded-md border border-input bg-background focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring">
                <span className="flex shrink-0 items-center gap-1.5 border-r border-input bg-muted/50 px-2.5 font-mono text-xs text-muted-foreground">
                  <currentPublishProvider.Icon className="size-3.5" />
                  {publishHost}/
                </span>
                <input
                  id="publish-repository-path"
                  name="publish-repository-path"
                  value={publishRepository}
                  onChange={(event) => {
                    setPublishRepositoryOverride(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      submitPublishRepository();
                    }
                  }}
                  placeholder={publishPathPlaceholder}
                  disabled={publishRepositoryAction.isPending}
                  className="w-full bg-transparent px-3 py-2 font-mono text-sm placeholder:text-muted-foreground/60 focus:outline-none"
                />
              </div>
            </div>

            <div className="space-y-2">
              <span
                id="publish-visibility-cards-label"
                className="text-xs font-medium text-foreground"
              >
                Visibility
              </span>
              <RadioGroup
                value={publishVisibility}
                onValueChange={(value) =>
                  setPublishVisibility(value as SourceControlRepositoryVisibility)
                }
                aria-labelledby="publish-visibility-cards-label"
                disabled={publishRepositoryAction.isPending}
                className="grid grid-cols-2"
              >
                {[
                  {
                    value: "private" as const,
                    label: "Private",
                    description: "Only invited people",
                    Icon: LockIcon,
                  },
                  {
                    value: "public" as const,
                    label: "Public",
                    description: "Anyone on the web",
                    Icon: GlobeIcon,
                  },
                ].map((option) => {
                  const isSelected = publishVisibility === option.value;
                  return (
                    <RadioPrimitive.Root
                      key={option.value}
                      value={option.value}
                      className={cn(
                        "relative flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]",
                        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                        isSelected
                          ? "border-primary bg-background shadow-sm ring-2 ring-inset ring-primary/35 dark:border-transparent dark:bg-primary/10 dark:shadow-none dark:ring-1 dark:ring-primary/30"
                          : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50 dark:border-transparent dark:bg-white/[0.035] dark:hover:bg-accent",
                      )}
                    >
                      <option.Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-foreground">
                          {option.label}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      </span>
                    </RadioPrimitive.Root>
                  );
                })}
              </RadioGroup>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setPublishAdvancedOpen((prev) => !prev)}
                aria-expanded={publishAdvancedOpen}
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDownIcon
                  className={cn(
                    "size-3.5 transition-transform",
                    publishAdvancedOpen ? "" : "-rotate-90",
                  )}
                />
                Advanced
              </button>
              {publishAdvancedOpen ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5" htmlFor="publish-remote-name">
                    <span className="text-xs font-medium text-foreground">Remote</span>
                    <Input
                      id="publish-remote-name"
                      value={publishRemoteName}
                      onChange={(event) => setPublishRemoteName(event.target.value)}
                      placeholder="origin"
                      disabled={publishRepositoryAction.isPending}
                    />
                  </label>
                  <div className="space-y-1.5">
                    <span
                      id="publish-protocol-label"
                      className="text-xs font-medium text-foreground"
                    >
                      Protocol
                    </span>
                    <ToggleGroup
                      value={[publishProtocol]}
                      onValueChange={(next) => {
                        const protocol = next[0];
                        if (protocol === "ssh" || protocol === "https") {
                          setPublishProtocol(protocol);
                        }
                      }}
                      aria-labelledby="publish-protocol-label"
                      disabled={publishRepositoryAction.isPending}
                    >
                      <Toggle value="ssh">SSH</Toggle>
                      <Toggle value="https">HTTPS</Toggle>
                    </ToggleGroup>
                  </div>
                </div>
              ) : null}
            </div>

            {publishRepositoryAction.isPending ? (
              <div
                role="status"
                aria-live="polite"
                className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-3 py-2 text-xs text-muted-foreground dark:border-transparent dark:bg-white/[0.035]"
              >
                <Spinner size="sm" aria-hidden />
                Publishing repository to {publishProviderLabel}...
              </div>
            ) : null}
            {publishError && !publishRepositoryAction.isPending ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                <p className="font-medium">Publish failed</p>
                <p className="mt-0.5 text-destructive/90">{publishError}</p>
              </div>
            ) : null}
          </div>

          <div className={cn("space-y-4", publishWizardStep !== 2 && "hidden")}>
            {publishResult ? (
              <>
                <div className="flex flex-col items-center gap-2 py-1 text-center">
                  <span className="grid size-8 place-items-center rounded-full bg-success/15 text-success">
                    <CheckIcon className="size-4" aria-hidden />
                  </span>
                  <h3 className="text-sm font-semibold text-foreground">
                    {publishResult.status === "pushed"
                      ? "Repository published"
                      : "Repository created"}
                  </h3>
                  <p className="max-w-xs text-pretty text-xs text-muted-foreground">
                    {publishResult.status === "pushed"
                      ? `${publishResult.branch} is now live on ${publishProviderLabel}.`
                      : `Remote "${publishResult.remoteName}" is set up. Make a commit and push it to share your code.`}
                  </p>
                </div>
                <div className="flex items-center gap-2 rounded-lg border border-input bg-muted/40 px-3 py-2 dark:border-transparent dark:bg-white/[0.035]">
                  <currentPublishProvider.Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                    {publishResult.repository.nameWithOwner}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => {
                    void openLink(publishResult.repository.url).catch(() => undefined);
                  }}
                >
                  Open on {publishProviderLabel}
                </Button>
              </>
            ) : (
              <div className="rounded-md border border-input bg-background px-3 py-2 text-xs text-muted-foreground dark:border-transparent dark:bg-white/[0.035]">
                Publish result unavailable.
              </div>
            )}
          </div>
        </WizardPanel>

        <WizardFooter>
          {publishWizardStep === 2 ? (
            <Button onClick={() => handleOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={publishRepositoryAction.isPending}
                onClick={() => {
                  if (publishWizardStep === 0) {
                    handleOpenChange(false);
                    return;
                  }
                  setPublishWizardStep((step) => Math.max(0, step - 1));
                }}
              >
                {publishWizardStep === 0 ? "Cancel" : "Back"}
              </Button>
              {publishWizardStep < 1 ? (
                <Button
                  disabled={!hasReadyPublishProvider || !selectedPublishProviderReadiness.ready}
                  onClick={() => setPublishWizardStep((step) => Math.min(1, step + 1))}
                >
                  Next
                </Button>
              ) : (
                <Button disabled={!canSubmitPublishRepository} onClick={submitPublishRepository}>
                  {publishRepositoryAction.isPending ? (
                    <>
                      <Spinner size="sm" aria-hidden />
                      Publishing...
                    </>
                  ) : (
                    "Publish"
                  )}
                </Button>
              )}
            </>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
