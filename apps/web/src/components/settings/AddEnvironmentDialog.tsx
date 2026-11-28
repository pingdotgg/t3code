import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import { pipe } from "effect/Function";
import { ChevronsLeftRightEllipsisIcon, PlusIcon, TerminalIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { T, useGT, useMessages, Var } from "gt-react";
import {
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

import { cn } from "../../lib/utils";
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
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { AnimatedHeight } from "../AnimatedHeight";
import { environmentCatalog } from "~/connection/catalog";
import {
  connectPairing as connectPairingAtom,
  connectSshEnvironment as connectSshEnvironmentAtom,
} from "~/connection/onboarding";
import { useEnvironmentQuery } from "~/state/query";
import { desktopSshHostsStateAtom, filterDiscoveredSshHosts } from "~/state/desktopSshHosts";
import { type EnvironmentPresentation, useRelayEnvironmentDiscovery } from "~/state/environments";
import type { AddEnvironmentPrefill } from "~/state/linkedThreadView";
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
  parsePairingUrlFields,
  parseRemotePairingFields,
  formatDesktopSshConnectionError,
} from "./ConnectionsSettings.logic";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

const SSH_PROTOCOL_NAME = "SSH";
const EMPTY_DISCOVERED_SSH_HOSTS: ReadonlyArray<DesktopDiscoveredSshHost> = [];
// known_hosts can list one host on several ports. Its own bracketed form keeps an IPv6
// host's port separate from the address; no portless known_hosts entry has that form.
const sshHostSuggestionValue = (target: DesktopDiscoveredSshHost) =>
  target.port === null ? target.alias : `[${target.alias}]:${target.port}`;

type PendingActionKind =
  | { readonly kind: "remote" | "ssh"; readonly host: string }
  | { readonly kind: "relay" };
type PendingAction = PendingActionKind & { readonly target: string; readonly session: number };

export function AddEnvironmentDialog({
  open,
  prefill = null,
  routeTarget,
  error,
  savedEnvironments,
  initialHost = "",
  onOpenChange,
  onErrorChange,
}: {
  readonly open: boolean;
  /** A machine the user chose elsewhere to pair with; they supply only the pairing code. */
  readonly prefill?: AddEnvironmentPrefill | null;
  readonly routeTarget: EnvironmentPresentation | null;
  /** An address already known for the machine being added, such as one a link uses. */
  readonly initialHost?: string;
  readonly error: string | null;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onErrorChange: (error: string | null) => void;
}) {
  const gt = useGT();
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
  const [savedBackendMode, setSavedBackendMode] = useState<"remote" | "ssh">("remote");
  const [savedBackendHost, setSavedBackendHost] = useState(prefill?.host ?? initialHost);
  const [savedBackendPairingCode, setSavedBackendPairingCode] = useState("");
  const [savedBackendSshHost, setSavedBackendSshHost] = useState("");
  const [savedBackendSshUsername, setSavedBackendSshUsername] = useState("");
  const [savedBackendSshPort, setSavedBackendSshPort] = useState("");
  const [sshHostSuggestionsOpen, setSshHostSuggestionsOpen] = useState(false);
  const highlightedSshHostRef = useRef<DesktopDiscoveredSshHost | undefined>(undefined);
  const [pendingActions, setPendingActions] = useState<
    Readonly<Partial<Record<string, PendingAction>>>
  >({});
  const savedBackendSessionRef = useRef(0);
  const dialogTarget = routeTarget
    ? `route:${routeTarget.environmentId}`
    : prefill
      ? `prefill:${prefill.environmentId}`
      : "new";
  // A dismissed attempt keeps running, so reopening the dialog for its target shows it.
  // The dialog for any other target stays usable and never shows that attempt's host.
  const visiblePendingAction = pendingActions[dialogTarget] ?? null;
  const isAddingSavedBackend = visiblePendingAction !== null;
  const startAttempt = (action: PendingActionKind): PendingAction => {
    const attempt = { ...action, target: dialogTarget, session: savedBackendSessionRef.current };
    setPendingActions((current) => ({ ...current, [dialogTarget]: attempt }));
    return attempt;
  };
  const finishAttempt = (attempt: PendingAction) =>
    setPendingActions((current) => {
      if (current[attempt.target] !== attempt) return current;
      const rest = { ...current };
      delete rest[attempt.target];
      return rest;
    });
  // Dismissing the dialog starts a new session; a late result then only shows a toast.
  const isAttemptOnScreen = (attempt: PendingAction) =>
    attempt.session === savedBackendSessionRef.current;
  const isSshDiscoveryActive = desktopBridge !== undefined && open && savedBackendMode === "ssh";
  const desktopSshHosts = useEnvironmentQuery(
    isSshDiscoveryActive ? desktopSshHostsStateAtom : null,
    useMessages(),
  );
  // The discovery atom is kept alive across dialog opens, so re-read SSH config
  // each time the SSH tab is shown; stale hosts stay visible while it refreshes.
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
    savedBackendSshHost,
  );
  const isLoadingDiscoveredSshHosts = desktopSshHosts.isPending && desktopSshHosts.data === null;
  const discoveredSshHostsError = desktopSshHosts.error;
  const hasSshHostSuggestionContent =
    desktopBridge !== undefined &&
    (isLoadingDiscoveredSshHosts || unsavedDiscoveredSshHosts.length > 0);
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      savedBackendSessionRef.current += 1;
      setSavedBackendMode("remote");
      setSavedBackendHost(initialHost);
      setSavedBackendPairingCode("");
      setSavedBackendSshHost("");
      setSavedBackendSshUsername("");
      setSavedBackendSshPort("");
    }
    onOpenChange(nextOpen);
  };
  const connectSavedBackendSshTarget = async (target: DesktopSshEnvironmentTarget) => {
    const attempt = startAttempt({ kind: "ssh", host: target.alias });
    onErrorChange(null);
    const result = await connectSshEnvironment({
      target,
      label: "",
      ...(routeTarget ? { expectedEnvironmentId: routeTarget.environmentId } : {}),
    });
    finishAttempt(attempt);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const message = pipe(squashAtomCommandFailure(result), formatDesktopSshConnectionError);
      if (isAttemptOnScreen(attempt)) {
        onErrorChange(message);
      } else {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not add backend"),
            description: message,
          }),
        );
      }
      return;
    }

    if (isAttemptOnScreen(attempt)) handleOpenChange(false);
    toastManager.add({
      type: "success",
      title: routeTarget ? gt("Route added") : gt("Environment connected"),
      description: routeTarget
        ? gt("{environment} can now be reached over SSH {host}.", {
            environment: routeTarget.label,
            host: target.alias,
          })
        : gt("{host} is ready over an SSH-managed tunnel.", { host: target.alias }),
    });
  };

  const handleAddSavedBackend = async () => {
    if (isAddingSavedBackend) return;
    if (savedBackendMode === "ssh") {
      let target: DesktopSshEnvironmentTarget;
      try {
        target = parseManualDesktopSshTarget({
          host: savedBackendSshHost,
          username: savedBackendSshUsername,
          port: savedBackendSshPort,
        });
      } catch (error) {
        onErrorChange(formatDesktopSshConnectionError(error));
        return;
      }

      await connectSavedBackendSshTarget(target);
      return;
    }

    onErrorChange(null);
    let remotePairingInput: ReturnType<typeof parseRemotePairingFields>;
    try {
      remotePairingInput = parseRemotePairingFields({
        host: savedBackendHost,
        pairingCode: savedBackendPairingCode,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? (thrownErrorMessage(error, m) ?? error.message)
          : gt("Failed to add backend.");
      onErrorChange(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not add backend"),
          description: message,
        }),
      );
      return;
    }

    const attempt = startAttempt({ kind: "remote", host: remotePairingInput.host });
    const expected = routeTarget ?? prefill;
    const result = await connectPairing({
      ...remotePairingInput,
      ...(expected ? { expectedEnvironmentId: expected.environmentId } : {}),
    });
    finishAttempt(attempt);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        const message =
          error instanceof Error
            ? (thrownErrorMessage(error, m) ?? error.message)
            : gt("Failed to add backend.");
        if (isAttemptOnScreen(attempt)) onErrorChange(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not add backend"),
            description: message,
          }),
        );
      }
      return;
    }

    if (isAttemptOnScreen(attempt)) handleOpenChange(false);
    toastManager.add(
      routeTarget
        ? {
            type: "success",
            title: gt("Route added"),
            description: gt("{environment} now has another way to connect.", {
              environment: routeTarget.label,
            }),
          }
        : {
            type: "success",
            title: gt("Backend added"),
            description: gt("The environment is saved and will reconnect on app startup."),
          },
    );
  };

  const canSubmitRemote = savedBackendHost.trim().length > 0;
  const handleRemoteFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && canSubmitRemote) {
      event.preventDefault();
      void handleAddSavedBackend();
    }
  };

  const handleSavedBackendSshFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && savedBackendSshHost.trim().length > 0) {
      event.preventDefault();
      void handleAddSavedBackend();
    }
  };

  const handleSelectSshHostSuggestion = async (target: DesktopDiscoveredSshHost) => {
    if (isAddingSavedBackend || !desktopBridge) return;

    const attempt = startAttempt({ kind: "ssh", host: target.alias });
    onErrorChange(null);
    setSavedBackendSshHost(target.alias);
    let resolved: DesktopSshEnvironmentTarget;
    try {
      resolved = await desktopBridge.resolveSshHost(target.alias);
    } catch (error) {
      finishAttempt(attempt);
      const message = formatDesktopSshConnectionError(error);
      if (isAttemptOnScreen(attempt)) {
        onErrorChange(message);
      } else {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not add backend"),
            description: message,
          }),
        );
      }
      return;
    }
    finishAttempt(attempt);
    if (!isAttemptOnScreen(attempt)) return;
    if (target.port !== null) resolved = { ...resolved, port: target.port };
    setSavedBackendSshUsername(resolved.username ?? "");
    setSavedBackendSshPort(resolved.port === null ? "" : String(resolved.port));
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
      savedBackendSshHost.trim().length > 0
    ) {
      event.preventDefault();
      void handleAddSavedBackend();
    }
  };

  const splitPairingUrl = (value: string) => {
    const parsedPairingUrl = parsePairingUrlFields(value);
    if (!parsedPairingUrl) return false;
    setSavedBackendHost(parsedPairingUrl.host);
    setSavedBackendPairingCode(parsedPairingUrl.pairingCode);
    return true;
  };
  // Splitting while editing would cut the token short, so an edited URL is split when the
  // field loses focus. A paste, drop or autofill (no inputType in Chrome) splits at once.
  const handleSavedBackendHostChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    const inputType =
      event.nativeEvent instanceof InputEvent ? event.nativeEvent.inputType : undefined;
    const inserted =
      inputType === undefined ||
      inputType === "insertFromPaste" ||
      inputType === "insertFromDrop" ||
      inputType === "insertReplacementText";
    if (inserted && splitPairingUrl(value)) return;
    setSavedBackendHost(value);
  };
  const renderConnectionModeCard = (input: {
    readonly mode: "remote" | "ssh";
    readonly title: string;
    readonly description: string;
    readonly icon?: ReactNode;
  }) => {
    const selected = savedBackendMode === input.mode;
    return (
      <button
        type="button"
        aria-pressed={selected}
        className={cn(
          "group flex min-h-24 items-start gap-3 rounded-lg border p-4 text-left",
          selected ? "border-primary/50 bg-primary/5" : "border-border/60 hover:bg-muted/40",
        )}
        disabled={isAddingSavedBackend}
        onClick={() => {
          if (!selected) onErrorChange(null);
          setSavedBackendMode(input.mode);
        }}
      >
        {input.icon ? (
          <span
            className={cn(
              "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
              selected
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-border/70 bg-background text-muted-foreground group-hover:text-foreground",
            )}
          >
            {input.icon}
          </span>
        ) : null}
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{input.title}</span>
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            {input.description}
          </span>
        </span>
      </button>
    );
  };

  const renderRemoteFields = () => (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            <T>Host</T>
          </span>
          <Input
            value={savedBackendHost}
            onChange={handleSavedBackendHostChange}
            onBlur={(event) => splitPairingUrl(event.target.value)}
            onKeyDown={handleRemoteFieldKeyDown}
            placeholder="backend.example.com"
            disabled={isAddingSavedBackend}
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            <T>Pairing code</T>
          </span>
          <Input
            value={savedBackendPairingCode}
            onChange={(event) => setSavedBackendPairingCode(event.target.value)}
            onKeyDown={handleRemoteFieldKeyDown}
            placeholder={gt("PAIRCODE")}
            disabled={isAddingSavedBackend}
            spellCheck={false}
          />
        </label>
      </div>
      <div>
        <span className="mt-1 block text-2xs text-muted-foreground">
          <T>Paste a full pairing URL here to fill both fields automatically.</T>
        </span>
      </div>
    </div>
  );
  const relayRouteOffer =
    routeTarget !== null &&
    !routeTarget.relayManaged &&
    relayDiscoveryState.environments.has(routeTarget.environmentId)
      ? relayDiscoveryState.environments.get(routeTarget.environmentId)!.environment
      : null;
  const addRelayRoute = async () => {
    if (relayRouteOffer === null || routeTarget === null) return;
    const attempt = startAttempt({ kind: "relay" });
    const result = await registerEnvironment(
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: relayRouteOffer.environmentId,
          label: routeTarget.label,
        }),
      }),
    );
    finishAttempt(attempt);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      const message =
        error instanceof Error
          ? (thrownErrorMessage(error, m) ?? error.message)
          : gt("Could not add the route.");
      if (isAttemptOnScreen(attempt)) {
        onErrorChange(message);
      } else {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not add the route."),
            description: message,
          }),
        );
      }
      return;
    }
    if (isAttemptOnScreen(attempt)) handleOpenChange(false);
    toastManager.add({
      type: "success",
      title: gt("Route added"),
      description: gt(
        "{environment} falls back to T3 Connect when its other routes are unreachable.",
        { environment: routeTarget.label },
      ),
    });
  };
  const renderSubmit = (input: {
    readonly canSubmit: boolean;
    readonly errorMessage: string | null;
  }) => {
    // Shown whichever mode is selected: a dismissed attempt keeps running after the form resets.
    const progress =
      visiblePendingAction?.kind === "ssh"
        ? {
            label: gt("Connecting to {host}…", { host: visiblePendingAction.host }),
            detail: gt(
              "Starting T3 Code on {host} and opening an SSH tunnel. This can take a minute.",
              { host: visiblePendingAction.host },
            ),
          }
        : visiblePendingAction?.kind === "remote"
          ? { label: gt("Pairing with {host}…", { host: visiblePendingAction.host }), detail: null }
          : null;
    return (
      <div className="space-y-3">
        {input.errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{input.errorMessage}</AlertDescription>
          </Alert>
        ) : null}
        <Button
          className="w-full"
          disabled={isAddingSavedBackend || !input.canSubmit}
          onClick={() => void handleAddSavedBackend()}
        >
          {progress ? <Spinner /> : <PlusIcon className="size-3.5" />}
          <span className="min-w-0 truncate">
            {progress ? progress.label : routeTarget ? gt("Add route") : gt("Connect & add")}
          </span>
        </Button>
        {/* Always mounted, so screen readers announce the target; the spinner only says loading. */}
        <span aria-live="polite" className="sr-only">
          {progress ? [progress.label, progress.detail].filter(Boolean).join(" ") : null}
        </span>
        {progress?.detail ? (
          <p className="text-center text-xs text-muted-foreground">{progress.detail}</p>
        ) : null}
      </div>
    );
  };
  const renderRemoteModeBody = () => (
    <div className="space-y-4">
      {relayRouteOffer !== null ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
          <p className="text-xs text-muted-foreground">
            <T>This machine is on your T3 Connect account. Use it as a fallback route.</T>
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={isAddingSavedBackend}
            onClick={() => void addRelayRoute()}
          >
            {visiblePendingAction?.kind === "relay" ? <Spinner /> : null}
            <T>Add T3 Connect</T>
          </Button>
        </div>
      ) : null}
      {renderRemoteFields()}
      {renderSubmit({
        canSubmit: canSubmitRemote,
        errorMessage: error,
      })}
    </div>
  );
  const renderSshFields = () => (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="block">
          <label
            htmlFor="saved-backend-ssh-host"
            className="mb-1.5 block text-xs font-medium text-foreground"
          >
            <T>SSH host or alias</T>
          </label>
          <Autocomplete
            items={filteredDiscoveredSshHosts}
            itemToStringValue={sshHostSuggestionValue}
            mode="none"
            openOnInputClick
            open={sshHostSuggestionsOpen}
            onOpenChange={setSshHostSuggestionsOpen}
            onItemHighlighted={(target) => {
              highlightedSshHostRef.current = target;
            }}
            value={savedBackendSshHost}
            onValueChange={(value, eventDetails) => {
              setSavedBackendSshHost(value);
              if (eventDetails.reason !== "item-press") return;

              const target = filteredDiscoveredSshHosts.find(
                (host) => sshHostSuggestionValue(host) === value,
              );
              if (target) void handleSelectSshHostSuggestion(target);
            }}
          >
            <AutocompleteInput
              id="saved-backend-ssh-host"
              onKeyDown={handleSavedBackendSshHostKeyDown}
              placeholder={gt("Search hosts or type devbox")}
              disabled={isAddingSavedBackend}
              spellCheck={false}
            />
            {hasSshHostSuggestionContent ? (
              <AutocompletePopup>
                {isLoadingDiscoveredSshHosts ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    <T>Loading hosts…</T>
                  </div>
                ) : filteredDiscoveredSshHosts.length > 0 ? (
                  <AutocompleteList scrollAreaClassName="max-h-72">
                    {filteredDiscoveredSshHosts.map((target, index) => {
                      const address = formatDesktopSshTarget(target);
                      const shortcutCommand = index < 9 ? threadJumpCommandForIndex(index) : null;
                      const shortcutLabel = shortcutCommand
                        ? shortcutLabelForCommand(keybindings, shortcutCommand, navigator.platform)
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
                            <CommandShortcut className="shrink-0">{shortcutLabel}</CommandShortcut>
                          ) : null}
                        </AutocompleteItem>
                      );
                    })}
                  </AutocompleteList>
                ) : (
                  <AutocompleteEmpty className="break-all">
                    <T>
                      No hosts match "<Var>{savedBackendSshHost.trim()}</Var>".
                    </T>
                  </AutocompleteEmpty>
                )}
              </AutocompletePopup>
            ) : null}
          </Autocomplete>
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              <T>Username</T>
            </span>
            <Input
              value={savedBackendSshUsername}
              onChange={(event) => setSavedBackendSshUsername(event.target.value)}
              onKeyDown={handleSavedBackendSshFieldKeyDown}
              placeholder="root"
              disabled={isAddingSavedBackend}
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              <T>Port</T>
            </span>
            <Input
              value={savedBackendSshPort}
              onChange={(event) => setSavedBackendSshPort(event.target.value)}
              onKeyDown={handleSavedBackendSshFieldKeyDown}
              placeholder="22"
              inputMode="numeric"
              disabled={isAddingSavedBackend}
              spellCheck={false}
            />
          </label>
        </div>
        {renderSubmit({
          canSubmit: savedBackendSshHost.trim().length > 0,
          errorMessage: error ?? discoveredSshHostsError,
        })}
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <SharedTooltipTrigger
        render={
          <DialogTrigger
            render={
              <Button size="xs" variant="ghost-muted" aria-label={gt("Add environment")}>
                <PlusIcon className="size-3" />
                <span>
                  <T>Add environment</T>
                </span>
              </Button>
            }
          />
        }
        label={
          <>
            <T>Add environment</T>
          </>
        }
      />
      <DialogPopup className="max-h-[80dvh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {routeTarget
              ? gt("Add a route to {environment}", { environment: routeTarget.label })
              : prefill
                ? gt("Connect to {environment}", { environment: prefill.label })
                : gt("Add Environment")}
          </DialogTitle>
          <DialogDescription>
            {routeTarget
              ? gt(
                  "Pair this machine again over another address, such as its Tailscale name. It joins the existing routes instead of adding a second machine.",
                )
              : prefill
                ? gt(
                    "Create a pairing code on {environment}, in its Settings → Sharing & access or with `t3 auth pairing create`, and enter it here.",
                    { environment: prefill.label },
                  )
                : gt("Pair another environment to this client.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {renderConnectionModeCard({
                mode: "remote",
                title: gt("Remote link"),
                description: gt("Enter a backend host and pairing code."),
                icon: <ChevronsLeftRightEllipsisIcon aria-hidden className="size-4" />,
              })}
              {desktopBridge
                ? renderConnectionModeCard({
                    mode: "ssh",
                    title: SSH_PROTOCOL_NAME,
                    description: gt("Use local SSH config, agent, and tunnels for the backend."),
                    icon: <TerminalIcon aria-hidden className="size-4" />,
                  })
                : null}
            </div>
            <AnimatedHeight>
              {savedBackendMode === "ssh" ? renderSshFields() : renderRemoteModeBody()}
            </AnimatedHeight>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
