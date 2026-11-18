import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import {
  managedCapabilityDenial,
  managedRuntimeModeDenial,
} from "@t3tools/client-runtime/contract-labels";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import {
  AuthAccessWriteScope,
  AuthMcpClientAccess,
  AuthRelayReadScope,
  type EnvironmentConnectReachability,
  type EnvironmentId,
  mcpClientScopes,
  sessionGrantsScope,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, CopyIcon } from "lucide-react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import * as Result from "effect/Result";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { m } from "~/i18n/messages";
import { type ReactNode, useEffect, useEffectEvent, useState } from "react";

import { checkReachability, readLinkState } from "~/cloud/linkEnvironmentAtoms";
import { isManagedTunnelActive } from "~/cloud/t3ConnectState";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { readCachedCloudLinkState } from "~/cloud/cloudLinkState";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { useT3ConnectTurnOn } from "~/cloud/useT3ConnectTurnOn";
import {
  namedClipboardTarget,
  useCopyToClipboard,
  writeTextToClipboard,
} from "~/hooks/useCopyToClipboard";
import { useNowSecond } from "~/hooks/useNowSecond";
import { readLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  type EnvironmentPresentation,
  useEnvironmentIdentities,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { useManagedPolicy } from "~/state/managedPolicy";
import { mintMcpApprovalCodeOn } from "~/state/peerPairingCode";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { useEnvironmentScope, useEnvironmentSessionState } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { CommandBlock } from "../CommandBlock";
import { AccessOption, accessConfig } from "../auth/ConnectAgentSurface";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";
import { afterFailedCheck, resolveMcpGate } from "./mcpGate";
import { MCP_APPS, type McpApp, mcpHandoffAction, OTHER_MCP_APP_STEPS } from "./mcpApps";
import { appName } from "@t3tools/shared/appName";

const requestAtom = Atom.make<{ readonly environmentId: EnvironmentId | null } | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mcp:use-in-another-app"),
);

/** Opens the wizard for `environmentId`, or for the one Sharing & access picks when null. */
export function openUseInAnotherApp(environmentId: EnvironmentId | null): void {
  appAtomRegistry.set(requestAtom, { environmentId });
}

const close = () => appAtomRegistry.set(requestAtom, null);

/** Hosted once at the root, so Cmd-K and Settings can open it from anywhere. */
export function UseInAnotherAppDialogHost() {
  const request = useAtomValue(requestAtom);
  return request === null ? null : <UseInAnotherAppDialog requested={request.environmentId} />;
}

function UseInAnotherAppDialog({ requested }: { readonly requested: EnvironmentId | null }) {
  const { environment, label } = useAccessEnvironment(requested);
  const gt = useGT();
  const title = `${gt("Use {appName} in another app (MCP)", { appName: appName() })} · ${label ?? appName()}`;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <WizardPopup>
        {environment !== null && hasCloudPublicConfig() ? (
          <Wizard key={environment.environmentId} environment={environment} title={title} />
        ) : (
          <>
            <WizardHeader title={title} />
            <WizardPanel>
              <GateMessage
                title={
                  environment === null
                    ? gt("Connect to an environment first.")
                    : gt("T3 Connect is not available in this build.")
                }
              />
            </WizardPanel>
          </>
        )}
      </WizardPopup>
    </Dialog>
  );
}

const STEPS = [
  msg("App", { $context: "wizard step: choose the app" }),
  msg("Access", { $context: "wizard step: choose the access level" }),
  msg("Connect", { $context: "wizard step: connect the app" }),
] as const;
const HOSTED_APPROVAL_STEPS = [STEPS[0], STEPS[2]] as const;
type Step = 0 | 1 | 2;
type Choice = McpApp | "other";

function Wizard({
  environment,
  title,
}: {
  readonly environment: EnvironmentPresentation;
  readonly title: string;
}) {
  const gt = useGT();
  const m = useMessages();
  const gate = useGate(environment);
  const levels = useGrantableLevels(environment);
  const [step, setStep] = useState<Step>(0);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [picked, setPicked] = useState<AuthMcpClientAccess | null>(null);
  const access = picked ?? DEFAULT_LEVELS.find((level) => levels.get(level) === undefined) ?? null;
  const open = gate.gate.kind === "open";
  // The level is picked on the sign-in page, so the wizard neither asks for it nor needs a code.
  const hostedApproval =
    environment.serverConfig?.environment.capabilities.mcpHostedApproval === true;
  const steps = hostedApproval ? HOSTED_APPROVAL_STEPS : STEPS;
  const shownStep = hostedApproval && step === 2 ? 1 : step;
  const next = () => setStep(step === 0 ? (hostedApproval ? 2 : 1) : 2);
  const levelsHeading =
    choice === null || choice === "other"
      ? gt("What can the app do?")
      : gt("What can {app} do?", { app: choice.name });
  return (
    <>
      <WizardHeader title={title}>
        {open ? (
          <WizardSteps
            steps={steps.map((label) => m(label))}
            currentStep={shownStep}
            isStepDisabled={(index) => index > shownStep}
            onStepChange={(index) => setStep(hostedApproval && index === 1 ? 2 : (index as Step))}
          />
        ) : null}
      </WizardHeader>
      <WizardPanel>
        {gate.gate.kind !== "open" ? (
          <GateScreen environment={environment} gate={gate} />
        ) : step === 0 ? (
          <AppStep choice={choice} onChoose={setChoice} />
        ) : step === 1 ? (
          <section className="space-y-3">
            <h3 className="text-sm font-medium">{levelsHeading}</h3>
            <RadioGroup
              aria-label={levelsHeading}
              value={access}
              onValueChange={(value) => setPicked(value as AuthMcpClientAccess)}
            >
              {AuthMcpClientAccess.literals.map((level) => (
                <AccessOption
                  key={level}
                  access={level}
                  selected={level === access}
                  disabledReason={levels.get(level)}
                  description={
                    level === "full-access"
                      ? gt("Runs commands and edits files without asking")
                      : null
                  }
                />
              ))}
            </RadioGroup>
          </section>
        ) : choice !== null && (hostedApproval || access !== null) ? (
          <ConnectStep
            environment={environment}
            mcpUrl={gate.gate.mcpUrl}
            choice={choice}
            access={hostedApproval ? null : access}
          />
        ) : null}
      </WizardPanel>
      {open ? (
        <WizardFooter
          leading={step === 2 ? <ManageAccessButton environment={environment} /> : undefined}
        >
          {step === 1 ? (
            <Button variant="outline" onClick={() => setStep(0)}>
              <T>Back</T>
            </Button>
          ) : null}
          {step === 2 ? (
            <Button onClick={close}>
              <T>Done</T>
            </Button>
          ) : (
            <Button disabled={step === 0 ? choice === null : access === null} onClick={next}>
              <T>Next</T>
            </Button>
          )}
        </WizardFooter>
      ) : null}
    </>
  );
}

/** The level the Access step starts at: Auto, else the next one down that can be granted. */
const DEFAULT_LEVELS: readonly AuthMcpClientAccess[] = [
  "auto",
  "auto-accept-edits",
  "approval-required",
  "read-only",
];

/** Why each level cannot be granted on this environment; absent when it can. */
function useGrantableLevels(environment: EnvironmentPresentation) {
  const environmentId = environment.environmentId;
  const session = useEnvironmentSessionState(environmentId).data;
  const canMint = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const policy = useManagedPolicy(environmentId);
  const gt = useGT();
  const messages = useMessages();
  // The server refuses codes for any level when its policy keeps remote clients out.
  const remoteDenial = managedCapabilityDenial(policy, "remoteClients", messages);
  return new Map(
    AuthMcpClientAccess.literals.flatMap((level) => {
      const reason =
        remoteDenial ??
        (!canMint
          ? gt("This device needs the Manage access permission on {environment}.", {
              environment: environment.label,
            })
          : session === null ||
              !mcpClientScopes(level).every((scope) => sessionGrantsScope(session, scope))
            ? gt("This device cannot grant this on {environment}.", {
                environment: environment.label,
              })
            : level === "read-only"
              ? undefined
              : managedRuntimeModeDenial(policy, level, messages));
      return reason === undefined ? [] : [[level, reason] as const];
    }),
  );
}

function useGate(environment: EnvironmentPresentation) {
  const environmentId = environment.environmentId;
  const { isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const controller = useCloudLinkController(environmentId);
  const canReadRelay = useEnvironmentScope(environmentId, AuthRelayReadScope);
  const thisMachine =
    environmentId === usePrimaryEnvironmentId() ||
    isDesktopLocalConnectionTarget(environment.entry.target);
  const discovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  const refreshDiscovery = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const runCheck = useAtomCommand(checkReachability, { reportFailure: false });
  const readState = useAtomCommand(readLinkState, { reportFailure: false });
  const m = useMessages();
  // The gate opens on a check it ran, or on a newer one the link state reports. A failed run
  // counts only server checks newer than `since` (see afterFailedCheck); null waits for a retry.
  const [check, setCheck] = useState<
    | "idle"
    | "running"
    | { readonly result: EnvironmentConnectReachability | null; readonly since: string | null }
  >("idle");
  const [connecting, setConnecting] = useState(false);
  const linkState = controller.linkState.data;
  const reported = linkState?.reachability;
  const serverConfig = environment.serverConfig;
  const connected = environment.connection.phase === "connected";
  const relayEntry = discovery.environments.get(environmentId);
  const gate = resolveMcpGate(
    {
      signedIn: isSignedIn,
      connected,
      approvalCodes:
        serverConfig === null
          ? undefined
          : serverConfig.environment.capabilities.mcpApprovalCodes === true,
      canReadRelay,
      linkState,
      linkStateError: controller.linkState.error,
      thisMachine,
      relay:
        !discovery.refreshing && (discovery.offline || Option.isSome(discovery.error))
          ? { status: "failed" }
          : discovery.listed
            ? {
                status: "listed",
                endpoint: relayEntry?.environment.endpoint,
                availability: relayEntry?.availability,
              }
            : { status: "loading" },
      reachability:
        typeof check === "string"
          ? "checking"
          : reported !== undefined && check.since !== null && reported.checkedAt > check.since
            ? reported
            : check.result,
    },
    m,
  );
  const runReachabilityCheck = async () => {
    setCheck("running");
    // A saved machine's address comes from T3 Connect's list, which can be stale.
    if (!thisMachine) void refreshDiscovery();
    const prior = readCachedCloudLinkState({ environmentId });
    const result = await runCheck({ target: { environmentId } });
    controller.linkState.refresh();
    if (result._tag === "Success") {
      setCheck({ result: result.value, since: result.value.checkedAt });
      return;
    }
    const latest = await readState({ target: { environmentId } });
    setCheck(afterFailedCheck(prior, latest._tag === "Success" ? latest.value : null));
  };
  const turnOn = async () => {
    setConnecting(true);
    const ok = await controller.reconcileCloudState({
      managedTunnel: true,
      publish: controller.publishAgentActivity,
    });
    if (!ok) setConnecting(false);
  };
  // A cached link state can name a tunnel on a disconnected machine; checking it would fail and
  // spend the one automatic check.
  const canCheck = connected && linkState !== null && isManagedTunnelActive(linkState, undefined);
  const checkOnce = useEffectEvent(() => {
    if (check === "idle") void runReachabilityCheck();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server to check its tunnel once one exists
  useEffect(() => {
    if (canCheck) queueMicrotask(checkOnce);
  }, [canCheck]);
  // T3 Connect lists machines only once something asks, and a saved machine's gate reads that list.
  const discoverIfUnasked = useEffectEvent(() => {
    if (!thisMachine && !discovery.listed && !discovery.refreshing) void refreshDiscovery();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks T3 Connect for its machine list once the wizard opens signed in
  useEffect(() => {
    if (isSignedIn) discoverIfUnasked();
  }, [isSignedIn]);
  const waiting = gate.kind === "offline" || (connecting && gate.kind === "turn-on");
  const refreshLinkState = useEffectEvent(() => controller.linkState.refresh());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the server's link state while the tunnel starts; the server has no push for it
  useEffect(() => {
    if (!waiting) return;
    const interval = window.setInterval(() => refreshLinkState(), 5_000);
    return () => window.clearInterval(interval);
  }, [waiting]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops showing Connecting once a started tunnel has had time to come up
  useEffect(() => {
    if (!connecting) return;
    const timeout = window.setTimeout(() => setConnecting(false), 90_000);
    return () => window.clearTimeout(timeout);
  }, [connecting]);
  return {
    gate,
    connecting: connecting && gate.kind !== "open",
    check: runReachabilityCheck,
    // A disconnected machine cannot be checked; its list entry says when it is back.
    refreshList: () => void refreshDiscovery(),
    turnOn,
    operationError: controller.operationError,
    tunnelLimit: controller.tunnelLimit,
  };
}

type Gate = ReturnType<typeof useGate>;

function GateScreen({
  environment,
  gate: { gate, connecting, check, refreshList, turnOn, operationError, tunnelLimit },
}: {
  readonly environment: EnvironmentPresentation;
  readonly gate: Gate;
}) {
  const name = environment.label;
  const gt = useGT();
  const turnOnHere = useT3ConnectTurnOn(environment.environmentId);
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const retry = (onClick: () => void) => (
    <Button variant="outline" onClick={onClick}>
      <T>Check again</T>
    </Button>
  );
  const offlineTitle = gt("{environment}''s T3 Connect is offline", { environment: name });
  const cannotCheckTitle = gt("Can't check T3 Connect on {environment}", { environment: name });
  const checkAgain = retry(() => void check());
  switch (gate.kind) {
    case "checking":
      return (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner size="sm" tone="muted" />
          <T>Checking T3 Connect…</T>
        </p>
      );
    case "sign-in":
      return (
        <GateMessage
          title={gt("Sign in to T3 Connect")}
          lines={[
            gt(
              "Apps like Poke and Claude run in the cloud. They need a public address to reach {environment}.",
              { environment: name },
            ),
            gt("T3 Connect gives {environment} that address. Each app still needs your approval.", {
              environment: name,
            }),
          ]}
        >
          {/* Clerk's sign-in is its own modal, so this dialog closes first. */}
          <Button
            onClick={() => {
              close();
              openAuthPrompt();
            }}
          >
            <T>Sign in to T3 Connect</T>
          </Button>
        </GateMessage>
      );
    case "disconnected":
      return gate.relay === null ? (
        <GateMessage title={gt("Connect to {environment} first.", { environment: name })} />
      ) : (
        <GateMessage title={gate.relay === "offline" ? offlineTitle : cannotCheckTitle}>
          {retry(refreshList)}
        </GateMessage>
      );
    case "update":
      return (
        <GateMessage
          title={gt("Update {appName} on {environment}", { appName: appName(), environment: name })}
        />
      );
    case "no-relay-read":
      return (
        <GateMessage
          title={cannotCheckTitle}
          lines={[
            gt("This device needs the View relay permission on {environment}.", {
              environment: name,
            }),
          ]}
        />
      );
    case "error":
      return (
        <GateMessage title={cannotCheckTitle} lines={[gate.message]}>
          {checkAgain}
        </GateMessage>
      );
    case "turn-on":
    case "offline": {
      if (gate.kind === "offline" && !connecting) {
        const reachability = gate.reachability;
        return (
          <GateMessage
            title={reachability ? offlineTitle : cannotCheckTitle}
            lines={
              reachability ? [reachability.reason, gt("Fix: {fix}", { fix: reachability.fix })] : []
            }
          >
            {checkAgain}
          </GateMessage>
        );
      }
      return (
        <GateMessage
          title={gt("Turn on T3 Connect for {environment}", { environment: name })}
          lines={[
            gt("{environment} gets a public https address, with no router setup.", {
              environment: name,
            }),
            gt("Only apps you approve can use it. You can turn it off in Settings."),
          ]}
        >
          {turnOnHere.kind === "here" ? (
            <div className="space-y-2">
              <Button disabled={connecting} onClick={() => void turnOn()}>
                {connecting ? gt("Connecting…") : gt("Turn on")}
              </Button>
              {operationError ? (
                <p className="text-xs text-destructive-foreground">{operationError}</p>
              ) : null}
              {tunnelLimit !== null ? (
                <>
                  <p className="text-sm text-destructive-foreground">
                    <T>Your T3 Connect account is out of tunnels.</T>
                  </p>
                  <ManageAccessButton environment={environment} label={gt("Manage tunnels")} />
                </>
              ) : null}
            </div>
          ) : turnOnHere.kind === "policy" ? (
            <p className="text-sm text-muted-foreground">{turnOnHere.reason}</p>
          ) : (
            <div className="space-y-2 text-sm">
              <CommandBlock command="t3 connect link" />
              <p>
                <T>
                  Restart <Var>{appName()}</Var> on <Var>{name}</Var>.
                </T>
              </p>
              {checkAgain}
            </div>
          )}
        </GateMessage>
      );
    }
    case "open":
      return null;
  }
}

function GateMessage({
  title,
  lines = [],
  children,
}: {
  readonly title: string;
  readonly lines?: readonly string[];
  readonly children?: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-base font-medium">{title}</h3>
      {lines.length > 0 ? (
        <div className="space-y-1 text-sm text-muted-foreground">
          {lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}
      {children}
    </section>
  );
}

function AppStep({
  choice,
  onChoose,
}: {
  readonly choice: Choice | null;
  readonly onChoose: (choice: Choice) => void;
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">
        <T>Which app?</T>
      </h3>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {MCP_APPS.filter((app) => !app.hidden).map((app) => (
          <button
            key={app.id}
            type="button"
            aria-pressed={choice === app}
            onClick={() => onChoose(app)}
            className="flex min-w-0 flex-col items-center gap-2 rounded-lg border border-transparent px-1 py-3 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:border-primary aria-pressed:bg-primary/8"
          >
            <img
              src={app.logo}
              alt=""
              className="size-10 rounded-lg ring-1 ring-black/10 dark:ring-white/12"
            />
            <span className="max-w-full truncate whitespace-nowrap text-xs font-medium">
              {app.name}
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-pressed={choice === "other"}
        onClick={() => onChoose("other")}
        className="w-full rounded-lg border border-border px-3 py-2.5 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:border-primary aria-pressed:bg-primary/8"
      >
        <T>Something else…</T>
      </button>
    </section>
  );
}

function ConnectStep({
  environment,
  mcpUrl,
  choice,
  access,
}: {
  readonly environment: EnvironmentPresentation;
  readonly mcpUrl: string;
  readonly choice: Choice;
  /** Null when the sign-in page asks for the level, so no code is needed. */
  readonly access: AuthMcpClientAccess | null;
}) {
  const [anotherWay, setAnotherWay] = useState(choice === "other");
  const gt = useGT();
  const m = useMessages();
  const app = choice === "other" ? null : choice;
  const code =
    access === null ? (
      <p className="text-sm text-muted-foreground">
        {app === null
          ? gt(
              "When the app opens the sign-in page, choose what it may do and approve with your T3 Connect account.",
            )
          : gt(
              "When {app} opens the sign-in page, choose what it may do and approve with your T3 Connect account.",
              { app: app.name },
            )}
      </p>
    ) : (
      <ApprovalCode
        key={access}
        environmentId={environment.environmentId}
        name={environment.label}
        access={access}
      />
    );
  if (anotherWay || app === null) {
    const message = app?.handoff.kind === "copy-message" ? app.handoff.message(mcpUrl) : null;
    return (
      <section className="space-y-4">
        <CopyRow label={gt("URL")} value={mcpUrl} />
        {message ? (
          <CopyRow label={gt("Message", { $context: "message to send" })} value={message} />
        ) : null}
        <ol className="list-decimal space-y-1 ps-5 text-sm">
          {(app?.steps ?? OTHER_MCP_APP_STEPS).map((step) => (
            <li key={step}>{m(step)}</li>
          ))}
        </ol>
        {app === null ? (
          <p className="text-xs text-muted-foreground">
            <T>Apps that require their own client ID cannot connect.</T>
          </p>
        ) : app.docs ? (
          <TextButton onClick={() => openLink(app.docs ?? "")}>
            {gt("{app} help", { app: app.name })}
          </TextButton>
        ) : null}
        {code}
        {app === null ? null : (
          <TextButton onClick={() => setAnotherWay(false)}>
            {app.handoff.kind === "commands" ? gt("Back to commands") : gt("Back to one click")}
          </TextButton>
        )}
        <LinkedLine environment={environment} access={access} />
      </section>
    );
  }
  return (
    <section className="space-y-4">
      <PrimaryAction app={app} mcpUrl={mcpUrl} />
      <CopyRow label={gt("URL")} value={mcpUrl} />
      {code}
      <TextButton onClick={() => setAnotherWay(true)}>
        <T>Set up another way</T>
      </TextButton>
      <LinkedLine environment={environment} access={access} />
    </section>
  );
}

function TextButton({
  onClick,
  children,
}: {
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:underline"
    >
      {children}
    </button>
  );
}

function openLink(url: string) {
  void readLocalApi()
    ?.shell.openExternal(url)
    .catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: m(msg("Could not open the link")),
        description: thrownErrorMessage(error, m) ?? url,
      }),
    );
}

function PrimaryAction({ app, mcpUrl }: { readonly app: McpApp; readonly mcpUrl: string }) {
  const gt = useGT();
  const m = useMessages();
  const action = mcpHandoffAction(app, mcpUrl, m);
  const note = app.note ? <p className="text-xs text-muted-foreground">{m(app.note)}</p> : null;
  if (action === null) {
    return (
      <div className="space-y-2">
        {app.handoff.kind === "commands"
          ? app.handoff
              .commands(mcpUrl)
              .map((command) => <CommandBlock key={command} command={command} />)
          : null}
        <p className="text-xs text-muted-foreground">
          {gt("Run these where {app} runs.", { app: app.name })}
        </p>
        {note}
      </div>
    );
  }
  const { copy, link, appLink } = action;
  // The desktop app reports a link nothing opens and falls back; a browser cannot tell, and
  // opens an app link in place (a new tab for it would stay blank), so its toast keeps the web.
  const openApp = () => {
    if (appLink === null) return openLink(link);
    if (!isElectron) return window.location.assign(appLink);
    void readLocalApi()
      ?.shell.openExternal(appLink)
      .catch(() => openLink(link));
  };
  const handOff = async () => {
    if (copy !== null) {
      // The app opens only once the copy lands, so it never gets an older clipboard.
      const copied = await writeTextToClipboard(copy.text, namedClipboardTarget(copy.title)).catch(
        () => false,
      );
      if (!copied) {
        toastManager.add({
          type: "error",
          title: gt("Could not copy"),
          description: gt("Use Set up another way."),
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: copy.title,
        // A browser can block an open that follows the copy, and no platform reliably reports an
        // app link nothing handles (Linux says it opened), so these keep a way through.
        ...(isElectron && appLink === null
          ? {}
          : {
              actionProps: {
                children:
                  appLink === null
                    ? gt("Open {app}", { app: app.name })
                    : gt("Get {app}", { app: app.name }),
                onClick: () => openLink(link),
              },
            }),
      });
    }
    openApp();
  };
  return (
    <div className="space-y-2">
      <Button className="w-full" onClick={() => void handOff()}>
        {action.label}
      </Button>
      {note}
    </div>
  );
}

/** "Get code" mints on click; the code is never copied or sent anywhere by itself. */
function ApprovalCode({
  environmentId,
  name,
  access,
}: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly access: AuthMcpClientAccess;
}) {
  const [code, setCode] = useState<{
    readonly credential: string;
    readonly expiresAt: number;
  } | null>(null);
  const gt = useGT();
  const m = useMessages();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNowSecond();
  const live = code !== null && now < code.expiresAt;
  const mint = async () => {
    setPending(true);
    setError(null);
    const result = await mintMcpApprovalCodeOn(environmentId, access);
    setPending(false);
    if (Result.isSuccess(result)) {
      setCode({
        credential: result.success.credential,
        expiresAt: result.success.expiresAt.epochMilliseconds,
      });
    } else {
      setError(gt("Could not get a code from {environment}. Try again.", { environment: name }));
    }
  };
  const left = code === null ? 0 : Math.max(0, Math.floor((code.expiresAt - now) / 1000));
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">
          <T>
            Code to approve{" "}
            <span className="font-medium">
              <Var>{m(accessConfig[access].label)}</Var>
            </span>
          </T>
        </span>
        {live ? null : (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void mint()}>
            {pending ? gt("Getting code…") : code === null ? gt("Get code") : gt("New code")}
          </Button>
        )}
      </div>
      {code !== null ? (
        live ? (
          <>
            <CopyRow label={gt("Code", { $context: "approval code" })} value={code.credential} />
            <p className="text-xs text-muted-foreground">
              {gt("Expires {time} · one use", {
                time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`,
              })}
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            <T>The code expired.</T>
          </p>
        )
      ) : null}
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
    </div>
  );
}

function CopyRow({ label, value }: { readonly label: string; readonly value: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: namedClipboardTarget(label),
  });
  const gt = useGT();
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-sm">{value}</span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={gt("Copy {label}", { label })}
        onClick={() => copyToClipboard(value, undefined)}
      >
        {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}

const levelRank = (level: AuthMcpClientAccess) => AuthMcpClientAccess.literals.indexOf(level);

/** Machines this environment links to, at the level a call forwarded there gets. */
function LinkedLine({
  environment,
  access,
}: {
  readonly environment: EnvironmentPresentation;
  /** Null when the level is picked later; each link then shows its own. */
  readonly access: AuthMcpClientAccess | null;
}) {
  const offered = offersLinkedEnvironments(environment.serverConfig);
  const links = useEnvironmentQuery(
    offered
      ? peerLinkEnvironment.list({ environmentId: environment.environmentId, input: {} })
      : null,
  ).data?.links;
  const identities = useEnvironmentIdentities();
  const gt = useGT();
  const m = useMessages();
  if (!offered || links === undefined || links.length === 0) return null;
  const named = links.map((link) => {
    const name =
      identities.find((identity) => identity.environmentId === link.environmentId)?.label ??
      link.label;
    // A forwarded call keeps the lower of the app's level and the link's own.
    const level =
      access === null || levelRank(link.access) < levelRank(access) ? link.access : access;
    return `${name} · ${link.status === "expired" ? gt("Expired") : m(accessConfig[level].label)}`;
  });
  return (
    <p className="text-xs text-muted-foreground">
      {gt("Linked: {environments}", { environments: named.join(", ") })}
    </p>
  );
}

/** Opens Sharing & access on this environment, where its clients and T3 Connect tunnels live. */
function ManageAccessButton({
  environment,
  label,
}: {
  readonly environment: EnvironmentPresentation;
  readonly label?: string;
}) {
  const navigate = useNavigate();
  const gt = useGT();
  return (
    <Button
      variant="ghost"
      onClick={() => {
        close();
        void navigate({ to: "/settings/access", search: { machine: environment.environmentId } });
      }}
    >
      {label ?? gt("Manage access")}
    </Button>
  );
}
