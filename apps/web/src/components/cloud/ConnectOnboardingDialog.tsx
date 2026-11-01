import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import { AuthRelayReadScope, AuthRelayWriteScope, type AuthSessionState } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import {
  CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
  ConnectOnboardingOptOutSchema,
  EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE,
} from "~/cloud/connectOnboarding";
import { useManagedTunnelUsage } from "~/cloud/managedRelayState";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { isHostedStaticApp } from "~/hostedPairing";
import {
  useEnvironments,
  usePrimaryEnvironment,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { environmentSession, readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import {
  type T3ConnectAccountPageUrl,
  useT3ConnectAccountPage,
} from "../clerk/T3ConnectAccountPages";
import { CloudEnvironmentConnectRows } from "./CloudEnvironmentConnectList";
import { TunnelLimitAlert } from "./TunnelUsage";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog } from "../ui/dialog";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { WizardSteps, WizardPopup, WizardHeader, WizardPanel, WizardFooter } from "../ui/wizard";

export function ConnectOnboardingDialog() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredConnectOnboardingDialog />;
}

type OnboardingStep = "publish" | "devices";

const EMPTY_SESSION_STATE_ATOM = Atom.make(AsyncResult.initial<AuthSessionState>());

function ConfiguredConnectOnboardingDialog() {
  // Pending Clerk sessions must not look signed out or activation would look like a new sign-in.
  const { isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const [optOutState, setOptOutState] = useLocalStorage(
    CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
    EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE,
    ConnectOnboardingOptOutSchema,
  );

  const { environments, isReady: environmentsReady } = useEnvironments();
  // The empty hosted home already adds account computers after sign-in.
  const homeScreenAddsComputers =
    isHostedStaticApp() && environmentsReady && environments.length === 0;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primarySessionState = useAtomValue(
    primaryEnvironmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateAtom(primaryEnvironmentId),
  );
  const canReadRelay = useEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope);
  const canWriteRelay = useEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope);
  const canManageRelay = canReadRelay && canWriteRelay;
  const sessionScopesKnown =
    primaryEnvironmentId === null ? environmentsReady : primarySessionState._tag !== "Initial";

  const controller = useCloudLinkController();
  const accountPage = useT3ConnectAccountPage();
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
  const [prefilledFromLinkState, setPrefilledFromLinkState] = useState(false);
  // Start undefined so an existing account never looks like a fresh sign-in.
  const [observedAccount, setObservedAccount] = useState<string | null | undefined>(undefined);

  if (step === "publish" && sessionScopesKnown && !showPublishStep && !isApplying) {
    setStep("devices");
  }

  const optOutAccounts = optOutState.optOutAccounts;

  // A signed-in snapshot without userId is incomplete; recording signed-out would fake a fresh sign-in.
  if (isLoaded && !(isSignedIn && !userId)) {
    const nextAccount = isSignedIn && userId ? userId : null;
    if (nextAccount !== observedAccount) {
      setObservedAccount(nextAccount);
      if (observedAccount !== undefined && nextAccount !== null) {
        setRequestedAccount(nextAccount);
      }
    }
  }

  if (openForAccount !== null && (!isSignedIn || userId !== openForAccount)) {
    setOpenForAccount(null);
  }
  if (requestedAccount !== null && (!isSignedIn || userId !== requestedAccount)) {
    setRequestedAccount(null);
  }

  // Wait for the publish target before opening; otherwise the wizard can freeze on devices before publish
  // becomes available.
  const publishStepDecided = !canManageRelay || controller.linkState.target !== null;

  if (requestedAccount !== null && openForAccount === null) {
    if (homeScreenAddsComputers || optOutAccounts.includes(requestedAccount)) {
      setRequestedAccount(null);
    } else if (sessionScopesKnown && publishStepDecided) {
      setRequestedAccount(null);
      setPrefilledFromLinkState(false);
      setExposeEnvironment(true);
      setPublishAgentActivity(true);
      setDontShowAgain(false);
      setStep(canManageRelay && controller.linkState.target !== null ? "publish" : "devices");
      setOpenForAccount(requestedAccount);
    }
  }

  const linkStateData = controller.linkState.data;
  if (openForAccount !== null && !prefilledFromLinkState && linkStateData !== null) {
    setPrefilledFromLinkState(true);
    if (
      linkStateData.linked &&
      linkStateData.linkRevoked !== true &&
      linkStateData.cloudUserId === openForAccount
    ) {
      setExposeEnvironment(linkStateData.managedTunnelActive ?? linkStateData.linked);
      setPublishAgentActivity(linkStateData.publishAgentActivity);
    }
  }

  const complete = () => {
    if (isApplying) return;
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
    if (isApplying) return;
    if (
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope) ||
      !readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
    ) {
      setStep("devices");
      return;
    }
    if (linkStateData === null || controller.linkState.error !== null) return;
    // Onboarding only enables links; both toggles off must preserve existing links.
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

  const openAccountPage = accountPage.open;
  // The account page is a Clerk modal, so close this dialog before it opens.
  const leaveForAccountPage = openAccountPage
    ? (page: T3ConnectAccountPageUrl) => {
        complete();
        openAccountPage(page);
      }
    : null;

  return (
    <Dialog
      open={openForAccount !== null}
      onOpenChange={(open) => {
        if (!open && !isApplying) complete();
      }}
    >
      <WizardPopup>
        <WizardHeader
          title="Set up T3 Connect"
          description={
            <>
              Mesh your devices together. Publish this environment and connect the rest, all in one
              place.
            </>
          }
        >
          {steps.length > 1 ? (
            <WizardSteps
              steps={steps.map((id) => STEP_LABELS[id])}
              currentStep={steps.indexOf(step)}
              isStepDisabled={() => isApplying}
              onStepChange={(index) => {
                const next = steps[index];
                if (
                  next === "publish" &&
                  (primaryEnvironmentId === null ||
                    !readEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope) ||
                    !readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope))
                )
                  return;
                if (next) setStep(next);
              }}
            />
          ) : null}
        </WizardHeader>
        <WizardPanel>
          {step === "publish" ? (
            <PublishStep
              exposeEnvironment={exposeEnvironment}
              publishAgentActivity={publishAgentActivity}
              disabled={isApplying || !canManageRelay || linkStateData === null}
              operationError={controller.operationError ?? controller.linkState.error}
              tunnelLimit={controller.tunnelLimit}
              onOpenAccountPage={leaveForAccountPage}
              onExposeEnvironmentChange={(enabled) => {
                if (
                  primaryEnvironmentId !== null &&
                  readEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope) &&
                  readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
                )
                  setExposeEnvironment(enabled);
              }}
              onPublishAgentActivityChange={(enabled) => {
                if (
                  primaryEnvironmentId !== null &&
                  readEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope) &&
                  readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
                )
                  setPublishAgentActivity(enabled);
              }}
            />
          ) : (
            <DevicesStep />
          )}
        </WizardPanel>
        <WizardFooter
          leading={
            <label className="flex cursor-pointer items-center gap-2 self-start text-xs text-muted-foreground sm:self-center">
              <Checkbox
                checked={dontShowAgain}
                onCheckedChange={(checked) => setDontShowAgain(checked === true)}
              />
              Don&apos;t show this again
            </label>
          }
        >
          {step === "publish" ? (
            <>
              <Button variant="ghost" disabled={isApplying} onClick={() => setStep("devices")}>
                Not now
              </Button>
              <Button
                disabled={isApplying || !canManageRelay || linkStateData === null}
                onClick={() => void applyPublishSelection()}
              >
                {isApplying ? "Enabling…" : "Continue"}
              </Button>
            </>
          ) : (
            <Button disabled={isApplying} onClick={complete}>
              Done
            </Button>
          )}
        </WizardFooter>
      </WizardPopup>
      {/* Base UI renders Root children while closed, so this keeps the account page mounted. */}
      {accountPage.portals}
    </Dialog>
  );
}

const STEP_LABELS: Record<OnboardingStep, string> = {
  publish: "Publish",
  devices: "Connect devices",
};

function PublishStep({
  exposeEnvironment,
  publishAgentActivity,
  disabled,
  operationError,
  tunnelLimit,
  onOpenAccountPage,
  onExposeEnvironmentChange,
  onPublishAgentActivityChange,
}: {
  readonly exposeEnvironment: boolean;
  readonly publishAgentActivity: boolean;
  readonly disabled: boolean;
  readonly operationError: string | null;
  readonly tunnelLimit: number | null;
  readonly onOpenAccountPage: ((page: T3ConnectAccountPageUrl) => void) | null;
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
      {tunnelLimit !== null ? (
        <OnboardingTunnelLimitAlert onOpenAccountPage={onOpenAccountPage} />
      ) : null}
    </div>
  );
}

function OnboardingTunnelLimitAlert({
  onOpenAccountPage,
}: {
  readonly onOpenAccountPage: ((page: T3ConnectAccountPageUrl) => void) | null;
}) {
  const { upgrade } = useManagedTunnelUsage();
  return (
    <TunnelLimitAlert
      upgrade={upgrade}
      onLinkT3Chat={onOpenAccountPage ? () => onOpenAccountPage("t3-chat") : null}
      onManageTunnels={onOpenAccountPage ? () => onOpenAccountPage("t3-connect") : null}
    />
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
  const savedEnvironments = environments.filter(
    (environment) => environment.entry.target._tag !== "PrimaryConnectionTarget",
  );

  return (
    <div className="overflow-hidden rounded-lg border">
      <CloudEnvironmentConnectRows
        primaryEnvironmentId={primaryEnvironment?.environmentId ?? null}
        savedEnvironments={savedEnvironments}
        showSavedEnvironments
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
