import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import {
  AuthAccessWriteScope,
  AuthMcpClientAccess,
  AuthRelayReadScope,
  type EnvironmentConnectReachability,
  type EnvironmentId,
  managedCapabilityDenial,
  managedRuntimeModeDenial,
  mcpClientScopes,
  sessionGrantsScope,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Check, Copy } from "lucide";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import * as Result from "effect/Result";
import { type ReactNode, useEffect, useEffectEvent, useState } from "react";

import { useManagedTunnelUsage } from "~/cloud/managedRelayState";
import { checkReachability } from "~/cloud/linkEnvironmentAtoms";
import { isManagedTunnelActive } from "~/cloud/t3ConnectState";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { isElectron } from "~/env";
import { useT3ConnectTurnOn } from "~/cloud/useT3ConnectTurnOn";
import { useCopyToClipboard, writeTextToClipboard } from "~/hooks/useCopyToClipboard";
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
import { MorphIcon } from "../MorphIcon";
import { AccessOption, accessConfig } from "../auth/ConnectAgentSurface";
import { TunnelLimitAlert } from "../cloud/TunnelUsage";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";
import { resolveMcpGate } from "./mcpGate";
import { MCP_APPS, type McpApp, mcpHandoffAction, OTHER_MCP_APP_STEPS } from "./mcpApps";

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
  const title = `Use T3 Code in another app (MCP) · ${label ?? "T3 Code"}`;
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
                    ? "Connect to an environment first."
                    : "T3 Connect is not available in this build."
                }
              />
            </WizardPanel>
          </>
        )}
      </WizardPopup>
    </Dialog>
  );
}

const STEPS = ["App", "Access", "Connect"] as const;
type Step = 0 | 1 | 2;
type Choice = McpApp | "other";

function Wizard({
  environment,
  title,
}: {
  readonly environment: EnvironmentPresentation;
  readonly title: string;
}) {
  const gate = useGate(environment);
  const levels = useGrantableLevels(environment);
  const [step, setStep] = useState<Step>(0);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [picked, setPicked] = useState<AuthMcpClientAccess | null>(null);
  const access = picked ?? DEFAULT_LEVELS.find((level) => levels.get(level) === undefined) ?? null;
  const open = gate.gate.kind === "open";
  const appName = choice === null || choice === "other" ? "the app" : choice.name;
  return (
    <>
      <WizardHeader title={title}>
        {open ? (
          <WizardSteps
            steps={STEPS}
            currentStep={step}
            isStepDisabled={(index) => index > step}
            onStepChange={(index) => setStep(index as Step)}
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
            <h3 className="text-sm font-medium">What can {appName} do?</h3>
            <RadioGroup
              aria-label={`What can ${appName} do?`}
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
                    level === "full-access" ? "Runs commands and edits files without asking" : null
                  }
                />
              ))}
            </RadioGroup>
          </section>
        ) : choice !== null && access !== null ? (
          <ConnectStep
            environment={environment}
            mcpUrl={gate.gate.mcpUrl}
            choice={choice}
            access={access}
          />
        ) : null}
      </WizardPanel>
      {open ? (
        <WizardFooter
          leading={step === 2 ? <ManageAccessButton environment={environment} /> : undefined}
        >
          {step === 1 ? (
            <Button variant="outline" onClick={() => setStep(0)}>
              Back
            </Button>
          ) : null}
          {step === 2 ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <Button
              disabled={step === 0 ? choice === null : access === null}
              onClick={() => setStep(step === 0 ? 1 : 2)}
            >
              Next
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
  // The server refuses codes for any level when its policy keeps remote clients out.
  const remoteDenial = managedCapabilityDenial(policy, "remoteClients");
  return new Map(
    AuthMcpClientAccess.literals.flatMap((level) => {
      const reason =
        remoteDenial ??
        (!canMint
          ? `This device needs the Manage access permission on ${environment.label}.`
          : session === null ||
              !mcpClientScopes(level).every((scope) => sessionGrantsScope(session, scope))
            ? `This device cannot grant this on ${environment.label}.`
            : level === "read-only"
              ? undefined
              : managedRuntimeModeDenial(policy, level));
      return reason === undefined ? [] : [[level, reason] as const];
    }),
  );
}

function useGate(environment: EnvironmentPresentation) {
  const environmentId = environment.environmentId;
  const { isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const controller = useCloudLinkController(environmentId);
  const canReadRelay = useEnvironmentScope(environmentId, AuthRelayReadScope);
  const thisMachine = environmentId === usePrimaryEnvironmentId();
  const discovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  const refreshDiscovery = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const runCheck = useAtomCommand(checkReachability, { reportFailure: false });
  // The gate opens on a check it ran, or on a newer one the link state reports. A failed run
  // has no result, and counts only results newer than what the link state had then.
  const [check, setCheck] = useState<
    | "idle"
    | "running"
    | { readonly result: EnvironmentConnectReachability | null; readonly since: string }
  >("idle");
  const [connecting, setConnecting] = useState(false);
  const linkState = controller.linkState.data;
  const reported = linkState?.reachability;
  const serverConfig = environment.serverConfig;
  const gate = resolveMcpGate({
    signedIn: isSignedIn,
    connected: environment.connection.phase === "connected",
    approvalCodes:
      serverConfig === null
        ? undefined
        : serverConfig.environment.capabilities.mcpApprovalCodes === true,
    canReadRelay,
    linkState,
    linkStateError: controller.linkState.error,
    thisMachine,
    relay: discovery.listed
      ? {
          status: "listed",
          endpoint: discovery.environments.get(environmentId)?.environment.endpoint,
        }
      : {
          status:
            !discovery.refreshing && (discovery.offline || Option.isSome(discovery.error))
              ? "failed"
              : "loading",
        },
    reachability:
      typeof check === "string"
        ? "checking"
        : reported !== undefined && reported.checkedAt > check.since
          ? reported
          : check.result,
  });
  const runReachabilityCheck = async () => {
    setCheck("running");
    // A saved machine's address comes from T3 Connect's list, which can be stale.
    if (!thisMachine) void refreshDiscovery();
    const result = await runCheck({ target: { environmentId } });
    controller.linkState.refresh();
    setCheck(
      result._tag === "Success"
        ? { result: result.value, since: result.value.checkedAt }
        : { result: null, since: reported?.checkedAt ?? "" },
    );
  };
  const turnOn = async () => {
    setConnecting(true);
    const ok = await controller.reconcileCloudState({
      managedTunnel: true,
      publish: controller.publishAgentActivity,
    });
    if (!ok) setConnecting(false);
  };
  const tunnelActive = linkState !== null && isManagedTunnelActive(linkState, undefined);
  const discoverOnOpen = useEffectEvent(() => {
    if (!thisMachine) void refreshDiscovery();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- T3 Connect lists a saved machine's address only once asked, so ask when the wizard opens
  useEffect(() => {
    queueMicrotask(discoverOnOpen);
  }, []);
  const checkOnce = useEffectEvent(() => {
    if (check === "idle") void runReachabilityCheck();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server to check its tunnel once one exists
  useEffect(() => {
    if (tunnelActive) queueMicrotask(checkOnce);
  }, [tunnelActive]);
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
    turnOn,
    operationError: controller.operationError,
    tunnelLimit: controller.tunnelLimit,
  };
}

type Gate = ReturnType<typeof useGate>;

function GateScreen({
  environment,
  gate: { gate, connecting, check, turnOn, operationError, tunnelLimit },
}: {
  readonly environment: EnvironmentPresentation;
  readonly gate: Gate;
}) {
  const name = environment.label;
  const turnOnHere = useT3ConnectTurnOn(environment.environmentId);
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const { upgrade } = useManagedTunnelUsage();
  const checkAgain = (
    <Button variant="outline" onClick={() => void check()}>
      Check again
    </Button>
  );
  switch (gate.kind) {
    case "checking":
      return (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner size="sm" tone="muted" />
          Checking T3 Connect…
        </p>
      );
    case "sign-in":
      return (
        <GateMessage
          title="Sign in to T3 Connect"
          lines={[
            `Apps like Poke and Claude run in the cloud. They need a public address to reach ${name}.`,
            `T3 Connect gives ${name} that address. Each app still needs your approval.`,
          ]}
        >
          {/* Clerk's sign-in is its own modal, so this dialog closes first. */}
          <Button
            onClick={() => {
              close();
              openAuthPrompt();
            }}
          >
            Sign in to T3 Connect
          </Button>
        </GateMessage>
      );
    case "disconnected":
      return <GateMessage title={`Connect to ${name} first.`} />;
    case "update":
      return <GateMessage title={`Update T3 Code on ${name}`} />;
    case "no-relay-read":
      return (
        <GateMessage
          title={`Can't check T3 Connect on ${name}`}
          lines={[`This device needs the View relay permission on ${name}.`]}
        />
      );
    case "error":
      return (
        <GateMessage title={`Can't check T3 Connect on ${name}`} lines={[gate.message]}>
          {checkAgain}
        </GateMessage>
      );
    case "turn-on":
    case "offline": {
      if (gate.kind === "offline" && !connecting) {
        const reachability = gate.reachability;
        return (
          <GateMessage
            title={`${name}'s T3 Connect is offline`}
            lines={reachability ? [reachability.reason, `Fix: ${reachability.fix}`] : []}
          >
            {checkAgain}
          </GateMessage>
        );
      }
      return (
        <GateMessage
          title={`Turn on T3 Connect for ${name}`}
          lines={[
            `${name} gets a public https address, with no router setup.`,
            "Only apps you approve can use it. You can turn it off in Settings.",
          ]}
        >
          {turnOnHere.kind === "here" ? (
            <div className="space-y-2">
              <Button disabled={connecting} onClick={() => void turnOn()}>
                {connecting ? "Connecting…" : "Turn on"}
              </Button>
              {operationError ? (
                <p className="text-xs text-destructive-foreground">{operationError}</p>
              ) : null}
              {tunnelLimit !== null ? (
                <TunnelLimitAlert upgrade={upgrade} onLinkT3Chat={null} onManageTunnels={null} />
              ) : null}
            </div>
          ) : turnOnHere.kind === "policy" ? (
            <p className="text-sm text-muted-foreground">{turnOnHere.reason}</p>
          ) : (
            <div className="space-y-2 text-sm">
              <CommandBlock command="t3 connect link" />
              <p>Restart T3 Code on {name}.</p>
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
      <h3 className="text-sm font-medium">Which app?</h3>
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
        Something else…
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
  readonly access: AuthMcpClientAccess;
}) {
  const [anotherWay, setAnotherWay] = useState(choice === "other");
  const app = choice === "other" ? null : choice;
  const code = (
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
        <CopyRow label="URL" value={mcpUrl} />
        {message ? <CopyRow label="Message" value={message} /> : null}
        <ol className="list-decimal space-y-1 ps-5 text-sm">
          {(app?.steps ?? OTHER_MCP_APP_STEPS).map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {app === null ? (
          <p className="text-xs text-muted-foreground">
            Apps that ask for a client ID cannot connect.
          </p>
        ) : app.docs ? (
          <TextButton onClick={() => openLink(app.docs ?? "")}>{app.name} help</TextButton>
        ) : null}
        {code}
        {app === null ? null : (
          <TextButton onClick={() => setAnotherWay(false)}>
            {app.handoff.kind === "commands" ? "Back to commands" : "Back to one click"}
          </TextButton>
        )}
        <LinkedLine environment={environment} access={access} />
      </section>
    );
  }
  return (
    <section className="space-y-4">
      <PrimaryAction app={app} mcpUrl={mcpUrl} />
      <CopyRow label="URL" value={mcpUrl} />
      {code}
      <TextButton onClick={() => setAnotherWay(true)}>Set up another way</TextButton>
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
        title: "Could not open the link",
        description: error instanceof Error ? error.message : url,
      }),
    );
}

function PrimaryAction({ app, mcpUrl }: { readonly app: McpApp; readonly mcpUrl: string }) {
  const action = mcpHandoffAction(app, mcpUrl);
  const note = app.note ? <p className="text-xs text-muted-foreground">{app.note}</p> : null;
  if (action === null) {
    return (
      <div className="space-y-2">
        {app.handoff.kind === "commands"
          ? app.handoff
              .commands(mcpUrl)
              .map((command) => <CommandBlock key={command} command={command} />)
          : null}
        <p className="text-xs text-muted-foreground">Run them where {app.name} runs.</p>
        {note}
      </div>
    );
  }
  const { copy, link } = action;
  const handOff = async () => {
    if (copy === null) {
      openLink(link);
      return;
    }
    // Start the copy while this page has focus, and reserve the tab within this click, since
    // browsers block opens after an await. The app opens only once the copy lands.
    const copying = writeTextToClipboard(copy.text, copy.title).catch(() => false);
    const tab = isElectron ? null : window.open("", "_blank");
    if (tab) tab.opener = null;
    if (!(await copying)) {
      tab?.close();
      toastManager.add({
        type: "error",
        title: "Could not copy",
        description: "Use Set up another way.",
      });
      return;
    }
    if (tab) tab.location.href = link;
    else if (isElectron) openLink(link);
    toastManager.add({
      type: "success",
      title: copy.title,
      // A blocked tab still leaves a way to finish the handoff.
      ...(tab || isElectron
        ? {}
        : { actionProps: { children: `Open ${app.name}`, onClick: () => openLink(link) } }),
    });
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
      setError(`Could not get a code from ${name}. Try again.`);
    }
  };
  const left = code === null ? 0 : Math.max(0, Math.floor((code.expiresAt - now) / 1000));
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">
          Code to approve <span className="font-medium">{accessConfig[access].label}</span>
        </span>
        {live ? null : (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void mint()}>
            {pending ? "Getting code…" : code === null ? "Get code" : "New code"}
          </Button>
        )}
      </div>
      {code !== null ? (
        live ? (
          <>
            <CopyRow label="Code" value={code.credential} />
            <p className="text-xs text-muted-foreground">
              Expires {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} · one use
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">The code expired.</p>
        )
      ) : null}
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
    </div>
  );
}

function CopyRow({ label, value }: { readonly label: string; readonly value: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1500, target: label });
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-sm">{value}</span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Copy ${label}`}
        onClick={() => copyToClipboard(value, undefined)}
      >
        <MorphIcon className="size-3.5" icon={isCopied ? Check : Copy} />
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
  readonly access: AuthMcpClientAccess;
}) {
  const offered = offersLinkedEnvironments(environment.serverConfig);
  const links = useEnvironmentQuery(
    offered
      ? peerLinkEnvironment.list({ environmentId: environment.environmentId, input: {} })
      : null,
  ).data?.links;
  const identities = useEnvironmentIdentities();
  if (!offered || links === undefined || links.length === 0) return null;
  const named = links.map((link) => {
    const name =
      identities.find((identity) => identity.environmentId === link.environmentId)?.label ??
      link.label;
    // A forwarded call keeps the lower of the app's level and the link's own.
    const level = levelRank(link.access) < levelRank(access) ? link.access : access;
    return `${name} · ${link.status === "expired" ? "Expired" : accessConfig[level].label}`;
  });
  return <p className="text-xs text-muted-foreground">Linked: {named.join(", ")}</p>;
}

function ManageAccessButton({ environment }: { readonly environment: EnvironmentPresentation }) {
  const navigate = useNavigate();
  return (
    <Button
      variant="ghost"
      onClick={() => {
        close();
        void navigate({ to: "/settings/access", search: { machine: environment.environmentId } });
      }}
    >
      Manage access
    </Button>
  );
}
