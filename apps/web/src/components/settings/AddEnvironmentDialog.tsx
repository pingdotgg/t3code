import { EnvironmentConfirmationStep } from "./EnvironmentConfirmationStep";
import { EnvironmentTypeGrid } from "./EnvironmentTypeGrid";
import { CloudSandboxConfiguration, CloudSandboxDefaults } from "./CloudSandboxWizardSteps";
import { Loader2Icon, PlusIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  type CloudSandboxDriverKind,
  type DesktopDiscoveredSshHost,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";

import { formatDesktopSshTarget } from "./EnvironmentRow";
import { Input } from "../ui/input";
import { CommandShortcut } from "../ui/command";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../ui/autocomplete";
import { Dialog, DialogTrigger } from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";
import { environmentCatalog } from "~/connection/catalog";
import {
  connectPairing as connectPairingAtom,
  connectSshEnvironment as connectSshEnvironmentAtom,
} from "~/connection/onboarding";
import { useEnvironmentQuery } from "~/state/query";
import { desktopSshHostsStateAtom, filterDiscoveredSshHosts } from "~/state/desktopSshHosts";
import { type EnvironmentPresentation, useRelayEnvironmentDiscovery } from "~/state/environments";
import { useCloudSandboxProfileSetup } from "./useCloudSandboxProfileSetup";
import { useAtomCommand } from "../../state/use-atom-command";
import { primaryServerKeybindingsAtom } from "~/state/server";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
} from "../../keybindings";
import {
  parseManualDesktopSshTarget,
  parseRemotePairingFields,
  parsePairingUrlFields,
  formatDesktopSshConnectionError,
} from "./ConnectionsSettings.logic";
import {
  createInitialEnvironmentWizardDraft,
  getWizardStepsForType,
  resolveEnvironmentWizardNavigation,
  type EnvironmentType,
  type EnvironmentWizardDraft,
} from "./AddEnvironmentDialog.logic";

const EMPTY_DISCOVERED_SSH_HOSTS: ReadonlyArray<DesktopDiscoveredSshHost> = [];

export function AddEnvironmentDialog({
  open,
  routeTarget,
  error,
  savedEnvironments,
  onOpenChange,
  onErrorChange,
}: {
  readonly open: boolean;
  readonly routeTarget: EnvironmentPresentation | null;
  readonly error: string | null;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onErrorChange: (error: string | null) => void;
}) {
  const desktopBridge = window.desktopBridge;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const connectSshEnvironment = useAtomCommand(connectSshEnvironmentAtom, {
    reportFailure: false,
  });
  const registerEnvironment = useAtomCommand(environmentCatalog.register, {
    reportFailure: false,
  });
  const relayDiscoveryState = useRelayEnvironmentDiscovery();

  const savedDesktopSshEnvironmentKeys = (() => {
    const keys = new Set<string>();
    for (const environment of savedEnvironments) {
      const profile = environment.entry.profile;
      if (
        environment.entry.target._tag !== "SshConnectionTarget" ||
        Option.isNone(profile) ||
        profile.value._tag !== "SshConnectionProfile"
      ) {
        continue;
      }
      const target = profile.value.target;
      keys.add(target.alias);
      keys.add(formatDesktopSshTarget(target));
    }
    return keys;
  })();

  const [draft, setDraft] = useState<EnvironmentWizardDraft>(() =>
    createInitialEnvironmentWizardDraft("remote"),
  );
  const [wizardStep, setWizardStep] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [sshHostSuggestionsOpen, setSshHostSuggestionsOpen] = useState(false);
  const highlightedSshHostRef = useRef<DesktopDiscoveredSshHost | undefined>(undefined);
  const savedBackendSessionRef = useRef(0);

  const cloudSetup = useCloudSandboxProfileSetup({
    draft: draft.cloudSandbox,
    onChange: (cloudSandbox) => setDraft((previous) => ({ ...previous, cloudSandbox })),
    onError: (message) => {
      setStepError(message);
      onErrorChange(message);
    },
  });
  const isCheckingProfile = cloudSetup.checking;
  const busy = isConnecting || cloudSetup.saving;
  const steps = getWizardStepsForType(draft.type);
  const isLastStep = wizardStep === steps.length - 1;

  const isSshDiscoveryActive = desktopBridge !== undefined && open && draft.type === "ssh";
  const desktopSshHosts = useEnvironmentQuery(
    isSshDiscoveryActive ? desktopSshHostsStateAtom : null,
  );
  const refreshDesktopSshHosts = desktopSshHosts.refresh;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rereads desktop SSH config through the bridge each time the SSH tab is shown
  useEffect(() => {
    if (isSshDiscoveryActive) refreshDesktopSshHosts();
  }, [isSshDiscoveryActive, refreshDesktopSshHosts]);

  const discoveredSshHosts = desktopSshHosts.data ?? EMPTY_DISCOVERED_SSH_HOSTS;
  const unsavedDiscoveredSshHosts = discoveredSshHosts.filter((target) => {
    const address = formatDesktopSshTarget(target);
    return (
      !savedDesktopSshEnvironmentKeys.has(target.alias) &&
      (target.source === "ssh-config" || !savedDesktopSshEnvironmentKeys.has(address))
    );
  });
  const filteredDiscoveredSshHosts = filterDiscoveredSshHosts(
    unsavedDiscoveredSshHosts,
    draft.ssh.host,
  );
  const isLoadingDiscoveredSshHosts = desktopSshHosts.isPending && desktopSshHosts.data === null;
  const discoveredSshHostsError = desktopSshHosts.error;
  const hasSshHostSuggestionContent =
    desktopBridge !== undefined &&
    (isLoadingDiscoveredSshHosts || unsavedDiscoveredSshHosts.length > 0);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      savedBackendSessionRef.current += 1;
      setWizardStep(0);
      setDraft(createInitialEnvironmentWizardDraft("remote"));
      setIsConnecting(false);
      cloudSetup.reset();
      setStepError(null);
      onErrorChange(null);
    }
    onOpenChange(nextOpen);
  };

  const wizardContext = { hasStoredProviderKey: cloudSetup.storedKeyAvailable };

  // Step failures also go to the parent, so moving between steps clears both.
  const clearErrors = () => {
    setStepError(null);
    onErrorChange(null);
  };

  const handleTypeChange = (nextType: EnvironmentType, cloudDriver?: CloudSandboxDriverKind) => {
    setDraft((prev) => ({
      ...prev,
      type: nextType,
      ...(nextType === "cloudSandbox" || prev.type === "cloudSandbox"
        ? {
            cloudSandbox: {
              ...prev.cloudSandbox,
              ...(cloudDriver !== undefined ? { driverKind: cloudDriver } : {}),
              // A provider change invalidates the key's server-side profile.
              ...(cloudDriver !== undefined && prev.cloudSandbox.driverKind !== cloudDriver
                ? { apiKey: "", profileId: null }
                : {}),
            },
          }
        : {}),
    }));
    clearErrors();
  };

  const handleNext = async () => {
    const result = resolveEnvironmentWizardNavigation(wizardStep, "next", draft, wizardContext);
    if (result.kind === "blocked") {
      setStepError(result.error);
      return;
    }
    setStepError(null);

    if (draft.type === "cloudSandbox" && wizardStep === 1) {
      if (await cloudSetup.check()) setWizardStep(2);
      return;
    }

    setWizardStep(result.step);
  };

  const navigateToStep = async (targetStep: number) => {
    if (targetStep > wizardStep) {
      return;
    }
    const result = resolveEnvironmentWizardNavigation(wizardStep, targetStep, draft, wizardContext);
    if (result.kind === "blocked") {
      setStepError(result.error);
      return;
    }
    clearErrors();
    setWizardStep(result.step);
  };

  const handleBack = () => {
    clearErrors();
    setWizardStep((step) => Math.max(0, step - 1));
  };

  const connectSavedBackendSshTarget = async (target: DesktopSshEnvironmentTarget) => {
    const session = savedBackendSessionRef.current;
    setIsConnecting(true);
    setStepError(null);
    onErrorChange(null);
    const result = await connectSshEnvironment({
      target,
      label: draft.label.trim(),
      ...(routeTarget ? { expectedEnvironmentId: routeTarget.environmentId } : {}),
    });
    if (result._tag === "Failure") {
      if (session === savedBackendSessionRef.current && !isAtomCommandInterrupted(result)) {
        const formatted = formatDesktopSshConnectionError(squashAtomCommandFailure(result));
        setStepError(formatted);
        onErrorChange(formatted);
      }
      setIsConnecting(false);
      return;
    }

    handleOpenChange(false);
    toastManager.add({
      type: "success",
      title: routeTarget ? "Route added" : "Environment connected",
      description: routeTarget
        ? `${routeTarget.label} can now be reached over SSH ${target.alias}.`
        : `${target.alias} is ready over an SSH-managed tunnel.`,
    });
    setIsConnecting(false);
  };

  const handleConnect = async () => {
    if (draft.type === "ssh") {
      let target: DesktopSshEnvironmentTarget;
      try {
        target = parseManualDesktopSshTarget({
          host: draft.ssh.host,
          username: draft.ssh.username,
          port: draft.ssh.port,
        });
      } catch (err) {
        const formatted = formatDesktopSshConnectionError(err);
        setStepError(formatted);
        onErrorChange(formatted);
        return;
      }
      await connectSavedBackendSshTarget(target);
      return;
    }

    if (draft.type === "remote") {
      setIsConnecting(true);
      setStepError(null);
      onErrorChange(null);
      let remotePairingInput: ReturnType<typeof parseRemotePairingFields>;
      try {
        remotePairingInput = parseRemotePairingFields({
          host: draft.remote.host,
          pairingCode: draft.remote.pairingCode,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to add backend.";
        setStepError(message);
        onErrorChange(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not add backend",
            description: message,
          }),
        );
        setIsConnecting(false);
        return;
      }

      const result = await connectPairing({
        ...remotePairingInput,
        ...(routeTarget ? { expectedEnvironmentId: routeTarget.environmentId } : {}),
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          const message = failure instanceof Error ? failure.message : "Failed to add backend.";
          setStepError(message);
          onErrorChange(message);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not add backend",
              description: message,
            }),
          );
        }
        setIsConnecting(false);
        return;
      }

      handleOpenChange(false);
      toastManager.add(
        routeTarget
          ? {
              type: "success",
              title: "Route added",
              description: `${routeTarget.label} now has another way to connect.`,
            }
          : {
              type: "success",
              title: "Backend added",
              description: "The environment is saved and will reconnect on app startup.",
            },
      );
      setIsConnecting(false);
      return;
    }

    if (draft.type === "cloudSandbox" && (await cloudSetup.save())) {
      handleOpenChange(false);
      toastManager.add({
        type: "success",
        title: "Sandbox profile saved",
        description: "Threads and agents can now allocate cloud sandboxes.",
      });
    }
  };

  const handleSavedBackendSshFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && draft.ssh.host.trim().length > 0) {
      event.preventDefault();
      if (isLastStep) {
        void handleConnect();
      } else {
        handleNext();
      }
    }
  };

  const handleSelectSshHostSuggestion = async (target: DesktopDiscoveredSshHost) => {
    if (isConnecting || !desktopBridge) return;

    const session = savedBackendSessionRef.current;
    setIsConnecting(true);
    setStepError(null);
    onErrorChange(null);
    setDraft((prev) => ({
      ...prev,
      ssh: { ...prev.ssh, host: target.alias },
    }));

    let resolved: DesktopSshEnvironmentTarget;
    try {
      resolved = await desktopBridge.resolveSshHost(target.alias);
    } catch (err) {
      if (session === savedBackendSessionRef.current) {
        const formatted = formatDesktopSshConnectionError(err);
        setStepError(formatted);
        onErrorChange(formatted);
      }
      setIsConnecting(false);
      return;
    }
    if (session !== savedBackendSessionRef.current) {
      setIsConnecting(false);
      return;
    }
    setDraft((prev) => ({
      ...prev,
      ssh: {
        ...prev.ssh,
        host: resolved.hostname,
        username: resolved.username ?? "",
        port: resolved.port === null ? "" : String(resolved.port),
      },
    }));
    await connectSavedBackendSshTarget(resolved);
  };

  const handleSavedBackendSshHostKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;

    const isSshHostPopupVisible = sshHostSuggestionsOpen && hasSshHostSuggestionContent;
    if (isSshHostPopupVisible) {
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: { modelPickerOpen: false },
      });
      const index = threadJumpIndexFromCommand(command ?? "");
      const target = index === null ? undefined : filteredDiscoveredSshHosts[index];
      if (target) {
        event.preventDefault();
        event.stopPropagation();
        setSshHostSuggestionsOpen(false);
        void handleSelectSshHostSuggestion(target);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    const hasHighlightedSshHost =
      isSshHostPopupVisible && highlightedSshHostRef.current !== undefined;
    if (
      !event.defaultPrevented &&
      !hasHighlightedSshHost &&
      event.key === "Enter" &&
      draft.ssh.host.trim().length > 0
    ) {
      event.preventDefault();
      if (isLastStep) {
        void handleConnect();
      } else {
        handleNext();
      }
    }
  };

  const handleRemoteHostChange = (value: string) => {
    const parsed = parsePairingUrlFields(value);
    if (parsed) {
      setDraft((prev) => ({
        ...prev,
        remote: {
          host: parsed.host,
          pairingCode: parsed.pairingCode,
        },
      }));
      return;
    }
    setDraft((prev) => ({
      ...prev,
      remote: { ...prev.remote, host: value },
    }));
  };

  const relayRouteOffer =
    routeTarget !== null &&
    !routeTarget.relayManaged &&
    relayDiscoveryState.environments.has(routeTarget.environmentId)
      ? relayDiscoveryState.environments.get(routeTarget.environmentId)!.environment
      : null;

  const addRelayRoute = async () => {
    if (relayRouteOffer === null || routeTarget === null) return;
    setIsConnecting(true);
    const result = await registerEnvironment(
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: relayRouteOffer.environmentId,
          label: routeTarget.label,
        }),
      }),
    );
    setIsConnecting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        const msg = failure instanceof Error ? failure.message : "Could not add the route.";
        setStepError(msg);
        onErrorChange(msg);
      }
      return;
    }
    handleOpenChange(false);
    toastManager.add({
      type: "success",
      title: "Route added",
      description: `${routeTarget.label} falls back to T3 Connect when its other routes are unreachable.`,
    });
  };

  const activeError = stepError || error || discoveredSshHostsError;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={
                <Button size="xs" variant="ghost-muted" aria-label="Add environment">
                  <PlusIcon className="size-3" />
                  <span>Add environment</span>
                </Button>
              }
            />
          }
        />
        <TooltipPopup side="top">Add environment</TooltipPopup>
      </Tooltip>
      <WizardPopup size="wide">
        <WizardHeader
          title={routeTarget ? `Add a route to ${routeTarget.label}` : "Add Environment"}
          description={
            routeTarget
              ? "Pair this machine again over another address, such as its Tailscale name. It joins the existing routes instead of adding a second machine."
              : "Connect an environment with remote pairing, SSH, or a cloud sandbox."
          }
        >
          <WizardSteps
            steps={steps}
            currentStep={wizardStep}
            onStepChange={navigateToStep}
            isStepDisabled={(target) => busy || isCheckingProfile || target > wizardStep}
          />
        </WizardHeader>

        <WizardPanel className="min-h-56">
          {/* Step 0: Environment Type Selection */}
          <div className={wizardStep === 0 ? "grid gap-4" : "hidden"} hidden={wizardStep !== 0}>
            <div id="environment-type-label" className="text-sm font-medium text-foreground">
              Select environment type
            </div>
            <EnvironmentTypeGrid
              value={draft.type}
              cloudDriver={draft.cloudSandbox.driverKind}
              onValueChange={handleTypeChange}
              disabled={busy || isCheckingProfile}
              desktopBridgeAvailable={desktopBridge !== undefined}
              cloudSandboxAvailable={cloudSetup.available}
              aria-labelledby="environment-type-label"
            />
          </div>

          {/* Step 1: Configuration Forms */}
          <div className={wizardStep === 1 ? "grid gap-4" : "hidden"} hidden={wizardStep !== 1}>
            {draft.type === "remote" ? (
              <div className="space-y-4">
                {relayRouteOffer !== null ? (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                    <p className="text-xs text-muted-foreground">
                      This machine is on your T3 Connect account. Use it as a fallback route.
                    </p>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void addRelayRoute()}
                    >
                      Add T3 Connect
                    </Button>
                  </div>
                ) : null}
                <SettingsGroup variant="plain">
                  <SettingsRow
                    title={<label htmlFor="env-remote-host">Host</label>}
                    description="Hostname and port of the remote backend."
                    control={
                      <Input
                        id="env-remote-host"
                        value={draft.remote.host}
                        onChange={(e) => handleRemoteHostChange(e.target.value)}
                        placeholder="backend.example.com"
                        disabled={busy}
                        spellCheck={false}
                      />
                    }
                  />
                  <SettingsRow
                    title={<label htmlFor="env-remote-pairing">Pairing code</label>}
                    description="Authentication token or pairing code."
                    control={
                      <Input
                        id="env-remote-pairing"
                        value={draft.remote.pairingCode}
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            remote: { ...prev.remote, pairingCode: e.target.value },
                          }))
                        }
                        placeholder="PAIRCODE"
                        disabled={busy}
                        spellCheck={false}
                      />
                    }
                  />
                </SettingsGroup>
                <p className="text-2xs text-muted-foreground">
                  Paste a full pairing URL here to fill both fields automatically.
                </p>
              </div>
            ) : null}

            {draft.type === "ssh" ? (
              <div className="space-y-4">
                <SettingsGroup variant="plain">
                  <SettingsRow
                    title={<label htmlFor="saved-backend-ssh-host">SSH host or alias</label>}
                    description="Host configured in your SSH client or ~/.ssh/config."
                    control={
                      <Autocomplete
                        items={filteredDiscoveredSshHosts}
                        itemToStringValue={(target) => target.alias}
                        mode="none"
                        openOnInputClick
                        open={sshHostSuggestionsOpen}
                        onOpenChange={setSshHostSuggestionsOpen}
                        onItemHighlighted={(target) => {
                          highlightedSshHostRef.current = target;
                        }}
                        value={draft.ssh.host}
                        onValueChange={(value, eventDetails) => {
                          setDraft((prev) => ({
                            ...prev,
                            ssh: { ...prev.ssh, host: value },
                          }));
                          if (eventDetails.reason !== "item-press") return;
                          const target = filteredDiscoveredSshHosts.find((h) => h.alias === value);
                          if (target) void handleSelectSshHostSuggestion(target);
                        }}
                      >
                        <AutocompleteInput
                          id="saved-backend-ssh-host"
                          onKeyDown={handleSavedBackendSshHostKeyDown}
                          placeholder="Search hosts or type devbox"
                          disabled={busy}
                          spellCheck={false}
                        />
                        {hasSshHostSuggestionContent ? (
                          <AutocompletePopup>
                            {isLoadingDiscoveredSshHosts ? (
                              <div className="px-3 py-2 text-xs text-muted-foreground">
                                Loading hosts…
                              </div>
                            ) : filteredDiscoveredSshHosts.length > 0 ? (
                              <AutocompleteList className="max-h-72">
                                {filteredDiscoveredSshHosts.map((target, index) => {
                                  const address = formatDesktopSshTarget(target);
                                  const shortcutCommand =
                                    index < 9 ? threadJumpCommandForIndex(index) : null;
                                  const shortcutLabel = shortcutCommand
                                    ? shortcutLabelForCommand(
                                        keybindings,
                                        shortcutCommand,
                                        navigator.platform,
                                      )
                                    : null;
                                  return (
                                    <AutocompleteItem
                                      key={`${target.alias}:${target.hostname}:${target.port ?? ""}`}
                                      value={target}
                                      className="h-8 min-h-8 whitespace-nowrap"
                                    >
                                      <span className="min-w-0 truncate text-sm font-medium">
                                        {target.alias}
                                      </span>
                                      {address !== target.alias ? (
                                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                                          {address}
                                        </span>
                                      ) : (
                                        <span className="flex-1" />
                                      )}
                                      {shortcutLabel ? (
                                        <CommandShortcut className="shrink-0">
                                          {shortcutLabel}
                                        </CommandShortcut>
                                      ) : null}
                                    </AutocompleteItem>
                                  );
                                })}
                              </AutocompleteList>
                            ) : (
                              <AutocompleteEmpty className="break-all">
                                No hosts match "{draft.ssh.host.trim()}".
                              </AutocompleteEmpty>
                            )}
                          </AutocompletePopup>
                        ) : null}
                      </Autocomplete>
                    }
                  />
                  <SettingsRow
                    title={<label htmlFor="env-ssh-username">Username</label>}
                    description="Optional remote login username."
                    control={
                      <Input
                        id="env-ssh-username"
                        value={draft.ssh.username}
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            ssh: { ...prev.ssh, username: e.target.value },
                          }))
                        }
                        onKeyDown={handleSavedBackendSshFieldKeyDown}
                        placeholder="root"
                        disabled={busy}
                        spellCheck={false}
                      />
                    }
                  />
                  <SettingsRow
                    title={<label htmlFor="env-ssh-port">Port</label>}
                    description="SSH daemon port (default 22)."
                    control={
                      <Input
                        id="env-ssh-port"
                        value={draft.ssh.port}
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            ssh: { ...prev.ssh, port: e.target.value },
                          }))
                        }
                        onKeyDown={handleSavedBackendSshFieldKeyDown}
                        placeholder="22"
                        inputMode="numeric"
                        disabled={busy}
                        spellCheck={false}
                      />
                    }
                  />
                </SettingsGroup>
              </div>
            ) : null}

            {draft.type === "cloudSandbox" ? (
              <CloudSandboxConfiguration
                draft={draft.cloudSandbox}
                disabled={busy || isCheckingProfile}
                storedKeyAvailable={cloudSetup.storedKeyAvailable}
                onChange={(cloudSandbox) => setDraft((prev) => ({ ...prev, cloudSandbox }))}
              />
            ) : null}
          </div>

          {/* Step 2, and the last, of the cloud sandbox setup: its defaults. */}
          <div className={wizardStep === 2 ? "grid gap-4" : "hidden"} hidden={wizardStep !== 2}>
            {draft.type === "cloudSandbox" ? (
              <CloudSandboxDefaults
                draft={draft.cloudSandbox}
                disabled={busy || isCheckingProfile}
                onChange={(cloudSandbox) => setDraft((prev) => ({ ...prev, cloudSandbox }))}
              />
            ) : null}
          </div>

          {draft.type !== "cloudSandbox" ? (
            <div hidden={!isLastStep}>
              <EnvironmentConfirmationStep
                draft={draft}
                disabled={busy}
                onLabelChange={(label) => setDraft((previous) => ({ ...previous, label }))}
              />
            </div>
          ) : null}

          {activeError ? (
            <Alert variant="error" className="mt-3">
              <AlertDescription>{activeError}</AlertDescription>
            </Alert>
          ) : null}
        </WizardPanel>

        <WizardFooter
          leading={
            wizardStep === 0 ? (
              <Button
                variant="ghost-muted"
                size="sm"
                disabled={busy}
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled={busy} onClick={handleBack}>
                Back
              </Button>
            )
          }
        >
          {!isLastStep ? (
            <Button
              size="sm"
              onClick={() => void handleNext()}
              disabled={busy || isCheckingProfile}
            >
              {isCheckingProfile ? (
                <>
                  <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
                  Checking…
                </>
              ) : (
                "Next"
              )}
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => void handleConnect()}>
              {draft.type === "cloudSandbox" ? (
                busy ? (
                  <>
                    <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Finish"
                )
              ) : isConnecting ? (
                <>
                  <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
                  Connecting…
                </>
              ) : routeTarget ? (
                "Add route"
              ) : (
                "Connect"
              )}
            </Button>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
