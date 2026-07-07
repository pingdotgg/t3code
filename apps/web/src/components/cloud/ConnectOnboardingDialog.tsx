import { useAuth } from "@clerk/react";
import { AuthAdministrativeScopes, AuthRelayWriteScope } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
  ConnectOnboardingOptOutSchema,
  EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE,
} from "~/cloud/connectOnboarding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { usePrimarySessionState } from "~/environments/primary";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { CloudEnvironmentConnectRows } from "./CloudEnvironmentConnectList";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";

/**
 * Post-sign-in onboarding wizard for T3 Connect. Opens on every in-session
 * sign-in — sign-out removes the connected relay environments, so each new
 * session starts with no devices to reach. It first prompts to publish this
 * environment (managed tunnel + agent activity, both defaulting on) when the
 * current session is authorized to manage the relay link, then lists the
 * account's T3 Connect environments so every device can be connected right
 * away. A cold load with a restored session does not count as a sign-in.
 */
export function ConnectOnboardingDialog() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredConnectOnboardingDialog />;
}

type OnboardingStep = "publish" | "devices";

function ConfiguredConnectOnboardingDialog() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const [optOutState, setOptOutState] = useLocalStorage(
    CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
    EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE,
    ConnectOnboardingOptOutSchema,
  );

  const desktopBridge = window.desktopBridge;
  const primarySessionState = usePrimarySessionState();
  const currentSessionScopes = desktopBridge
    ? AuthAdministrativeScopes
    : primarySessionState.data?.authenticated
      ? (primarySessionState.data.scopes ?? null)
      : null;
  const canManageRelay = currentSessionScopes?.includes(AuthRelayWriteScope) ?? false;
  // The publish step is only offered when we know the answer; opening the
  // wizard before the session state resolves would let the step set change
  // mid-flight. A failed session read still opens the wizard — it just means
  // no publish step.
  const sessionScopesKnown =
    Boolean(desktopBridge) ||
    primarySessionState.data !== null ||
    primarySessionState.error !== null;

  const controller = useCloudLinkController();
  const showPublishStep = canManageRelay && controller.linkState.target !== null;
  const steps: ReadonlyArray<OnboardingStep> = showPublishStep
    ? ["publish", "devices"]
    : ["devices"];

  const [requestedAccount, setRequestedAccount] = useState<string | null>(null);
  const [openForAccount, setOpenForAccount] = useState<string | null>(null);
  const [step, setStep] = useState<OnboardingStep>("devices");
  const [exposeEnvironment, setExposeEnvironment] = useState(true);
  const [publishAgentActivity, setPublishAgentActivity] = useState(true);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const prefilledFromLinkStateRef = useRef(false);
  const observedAccountRef = useRef<string | null | undefined>(undefined);

  const optOutAccounts = optOutState.optOutAccounts;

  // Every sign-in that completes during this session requests the wizard. A
  // cold load observes undefined → account and must not re-prompt — only a
  // null → account transition is a sign-in.
  useEffect(() => {
    if (!isLoaded) return;
    const previousAccount = observedAccountRef.current;
    const nextAccount = isSignedIn && userId ? userId : null;
    observedAccountRef.current = nextAccount;
    if (previousAccount === null && nextAccount !== null) {
      setRequestedAccount(nextAccount);
    }
  }, [isLoaded, isSignedIn, userId]);

  // Open once the session scopes resolve so the step set is stable. Accounts
  // that chose "Don't show this again" are skipped.
  useEffect(() => {
    if (requestedAccount === null || openForAccount !== null) return;
    if (optOutAccounts.includes(requestedAccount)) {
      setRequestedAccount(null);
      return;
    }
    if (!sessionScopesKnown) return;
    setRequestedAccount(null);
    prefilledFromLinkStateRef.current = false;
    setExposeEnvironment(true);
    setPublishAgentActivity(true);
    setDontShowAgain(false);
    setStep(canManageRelay && controller.linkState.target !== null ? "publish" : "devices");
    setOpenForAccount(requestedAccount);
  }, [
    canManageRelay,
    controller.linkState.target,
    openForAccount,
    optOutAccounts,
    requestedAccount,
    sessionScopesKnown,
  ]);

  // Signing out (or switching accounts) mid-wizard invalidates everything the
  // wizard would do — close it and let the sign-in trigger re-evaluate.
  useEffect(() => {
    if (openForAccount !== null && (!isSignedIn || userId !== openForAccount)) {
      setOpenForAccount(null);
    }
    if (requestedAccount !== null && (!isSignedIn || userId !== requestedAccount)) {
      setRequestedAccount(null);
    }
  }, [isSignedIn, openForAccount, requestedAccount, userId]);

  // Toggles default on, but an environment that is already linked should show
  // its actual configuration instead of silently proposing to rewrite it.
  const linkStateData = controller.linkState.data;
  useEffect(() => {
    if (openForAccount === null || prefilledFromLinkStateRef.current || linkStateData === null) {
      return;
    }
    prefilledFromLinkStateRef.current = true;
    if (linkStateData.linked) {
      setExposeEnvironment(linkStateData.managedTunnelActive ?? linkStateData.linked);
      setPublishAgentActivity(linkStateData.publishAgentActivity);
    }
  }, [linkStateData, openForAccount]);

  const complete = () => {
    const account = openForAccount;
    setOpenForAccount(null);
    if (account !== null && dontShowAgain) {
      setOptOutState((state) =>
        state.optOutAccounts.includes(account)
          ? state
          : { optOutAccounts: [...state.optOutAccounts, account] },
      );
    }
  };

  const applyPublishSelection = async () => {
    // The wizard only ever enables — with both toggles off there is nothing to
    // apply, and an existing link must not be torn down from onboarding.
    if (!exposeEnvironment && !publishAgentActivity) {
      setStep("devices");
      return;
    }
    setIsApplying(true);
    const ok = await controller.reconcileCloudState({
      managedTunnel: exposeEnvironment,
      publish: publishAgentActivity,
    });
    setIsApplying(false);
    if (!ok) return;
    toastManager.add({
      type: "success",
      title: "T3 Connect enabled",
      description: exposeEnvironment
        ? "This environment is available to your other devices through T3 Connect."
        : "This environment publishes agent activity to your mobile clients.",
    });
    setStep("devices");
  };

  return (
    <Dialog
      open={openForAccount !== null}
      onOpenChange={(open) => {
        if (!open) complete();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Set up T3 Connect</DialogTitle>
          <DialogDescription>
            Mesh your devices together — publish this environment and connect the rest, all in one
            place.
          </DialogDescription>
          {steps.length > 1 ? (
            <OnboardingStepper steps={steps} currentStep={step} onStepSelect={setStep} />
          ) : null}
        </DialogHeader>
        <DialogPanel>
          {step === "publish" ? (
            <PublishStep
              exposeEnvironment={exposeEnvironment}
              publishAgentActivity={publishAgentActivity}
              disabled={isApplying}
              operationError={controller.operationError}
              onExposeEnvironmentChange={setExposeEnvironment}
              onPublishAgentActivityChange={setPublishAgentActivity}
            />
          ) : (
            <DevicesStep />
          )}
        </DialogPanel>
        <DialogFooter variant="bare" className="sm:justify-between">
          <label className="flex cursor-pointer items-center gap-2 self-start text-xs text-muted-foreground sm:self-center">
            <Checkbox
              checked={dontShowAgain}
              onCheckedChange={(checked) => setDontShowAgain(checked === true)}
            />
            Don&apos;t show this again
          </label>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            {step === "publish" ? (
              <>
                <Button variant="ghost" disabled={isApplying} onClick={() => setStep("devices")}>
                  Not now
                </Button>
                <Button
                  disabled={
                    isApplying || (controller.linkState.isPending && linkStateData === null)
                  }
                  onClick={() => void applyPublishSelection()}
                >
                  {isApplying ? "Enabling…" : "Continue"}
                </Button>
              </>
            ) : (
              <Button onClick={complete}>Done</Button>
            )}
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const STEP_LABELS: Record<OnboardingStep, string> = {
  publish: "Publish",
  devices: "Connect devices",
};

function OnboardingStepper({
  steps,
  currentStep,
  onStepSelect,
}: {
  readonly steps: ReadonlyArray<OnboardingStep>;
  readonly currentStep: OnboardingStep;
  readonly onStepSelect: (step: OnboardingStep) => void;
}) {
  const currentIndex = steps.indexOf(currentStep);
  return (
    <div className="grid grid-cols-2 gap-2">
      {steps.map((step, index) => (
        <button
          key={step}
          type="button"
          className={cn(
            "grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-lg border px-3 py-2 text-left",
            index === currentIndex
              ? "border-primary bg-primary/10 ring-1 ring-primary/25"
              : index < currentIndex
                ? "border-border bg-background"
                : "border-border bg-muted/40",
          )}
          onClick={() => onStepSelect(step)}
        >
          <span
            className={cn(
              "row-span-2 mt-0.5 grid size-4 place-items-center rounded-full border",
              index < currentIndex
                ? "border-primary bg-primary text-primary-foreground"
                : index === currentIndex
                  ? "border-primary bg-background"
                  : "border-muted-foreground/35 bg-background",
            )}
            aria-hidden
          >
            {index < currentIndex ? <CheckIcon className="size-3" /> : null}
          </span>
          <span className="text-[10px] font-medium uppercase text-muted-foreground">
            Step {index + 1}
          </span>
          <span className="truncate text-xs font-semibold text-foreground">
            {STEP_LABELS[step]}
          </span>
        </button>
      ))}
    </div>
  );
}

function PublishStep({
  exposeEnvironment,
  publishAgentActivity,
  disabled,
  operationError,
  onExposeEnvironmentChange,
  onPublishAgentActivityChange,
}: {
  readonly exposeEnvironment: boolean;
  readonly publishAgentActivity: boolean;
  readonly disabled: boolean;
  readonly operationError: string | null;
  readonly onExposeEnvironmentChange: (enabled: boolean) => void;
  readonly onPublishAgentActivityChange: (enabled: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border">
        <OnboardingToggleRow
          title="Publish this environment"
          description="Make this environment available to your other devices through T3 Connect."
          checked={exposeEnvironment}
          disabled={disabled}
          onCheckedChange={onExposeEnvironmentChange}
        />
        <OnboardingToggleRow
          title="Publish agent activity"
          description="Send activity from this environment to your mobile clients for push notifications and Live Activities."
          checked={publishAgentActivity}
          disabled={disabled}
          onCheckedChange={onPublishAgentActivityChange}
        />
      </div>
      {operationError ? <p className="text-xs text-destructive">{operationError}</p> : null}
    </div>
  );
}

function OnboardingToggleRow({
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly title: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-border/60 px-4 py-3 first:border-t-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        aria-label={title}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

function DevicesStep() {
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const savedEnvironmentIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.entry.target._tag !== "PrimaryConnectionTarget")
        .map((environment) => environment.environmentId),
    [environments],
  );

  return (
    <div className="overflow-hidden rounded-lg border">
      <CloudEnvironmentConnectRows
        primaryEnvironmentId={primaryEnvironment?.environmentId ?? null}
        savedEnvironmentIds={savedEnvironmentIds}
        showSavedAsConnected
        empty={
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No other environments are published to your account yet. Publish one from another device
            and it will show up here.
          </p>
        }
      />
    </div>
  );
}
