import { DeviceHostUpdates } from "./DeviceHostUpdates";
import type { DevicePlatform, DeviceServiceState, EnvironmentId } from "@t3tools/contracts";
import { Check, CircleAlert, Smartphone } from "lucide-react";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useAtomMount } from "@effect/atom-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { DialogClose } from "~/components/ui/dialog";
import { WizardHeader, WizardPanel, WizardSteps, WizardFooter } from "~/components/ui/wizard";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { deviceEnvironment, deviceHostProbeAtom, NO_DEVICE_PROBE_ATOM } from "~/state/device";
import { useAtomCommand } from "~/state/use-atom-command";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { cn } from "~/lib/utils";
import { m, type MessageResolver } from "~/i18n/messages";
import { PreviewEmptyHero } from "../preview/PreviewEmptyHero";

const platformName = (platform: DevicePlatform) => (platform === "ios" ? "iOS" : "Android");

const deviceHubDescription = msg(
  "Enable this environment to open simulators and emulators, whether they run here or on a remote device host.",
);
const agentDeviceDescription = msg(
  "Allow new agent sessions in this environment to start and control local and remote devices, with required tools set up automatically.",
);

/** Platforms whose latest listing on a ready host may be missing devices. */
export const incompleteListings = (
  status: DeviceServiceState["hostStatuses"][string] | undefined,
) =>
  (["ios", "android"] as const).filter(
    (platform) =>
      status?.status === "ready" &&
      (status.incompletePlatforms?.includes(platform) ||
        (platform === "android" && status.androidDiscoveryIncomplete === true)),
  );

export const isAndroidDiscoveryUncertain = (state: DeviceServiceState) =>
  Object.values(state.hostStatuses).some((status) =>
    incompleteListings(status).includes("android"),
  );

/**
 * `hostStatus` only tracks this machine. A machine without simulator tooling never
 * starts its own hub, so setup and the panel must also count remote device hosts.
 */
export function deviceHubReadiness(state: DeviceServiceState) {
  const statuses = Object.values(state.hostStatuses).map((host) => host.status);
  const ready = state.hostStatus === "ready" || statuses.includes("ready");
  const busy =
    !ready &&
    [state.hostStatus, ...statuses].some(
      (status) => status === "installing" || status === "starting",
    );
  return { ready, busy };
}

/** A ready host keeps its devices usable but may still carry a discovery warning. */
function deviceHostDiagnostics(
  hosts: ReadonlyArray<Pick<DeviceServiceState["hosts"][number], "id" | "label">>,
  hostStatuses: DeviceServiceState["hostStatuses"],
) {
  return hosts.flatMap((host) => {
    const status = hostStatuses[host.id];
    return status?.status === "ready" && status.detail
      ? [{ hostId: host.id, label: host.label, detail: status.detail }]
      : [];
  });
}

function DeviceHostDiagnostics(props: {
  readonly hosts: ReadonlyArray<Pick<DeviceServiceState["hosts"][number], "id" | "label">>;
  readonly hostStatuses: DeviceServiceState["hostStatuses"];
  readonly className?: string;
}) {
  const diagnostics = deviceHostDiagnostics(props.hosts, props.hostStatuses);
  if (diagnostics.length === 0) return null;
  return (
    <div role="status" className={cn("space-y-1 text-meta text-muted-foreground", props.className)}>
      {diagnostics.map(({ hostId, label, detail }) => (
        <p key={hostId} className="whitespace-pre-line break-words">
          <T>
            <Var>{label}</Var>: <Var>{detail}</Var>
          </T>
        </p>
      ))}
    </div>
  );
}

/** Components pass `useMessages()` so the message follows a language switch. */
export function platformSetupStatus(
  state: DeviceServiceState,
  platform: DevicePlatform,
  resolve: MessageResolver = m,
) {
  const hasDevices = state.devices.some((device) => device.platform === platform);
  if (platform === "android" && !hasDevices && isAndroidDiscoveryUncertain(state)) {
    return {
      ready: false,
      message: resolve(
        msg("The Android device list may be incomplete. Check the device host and try again."),
      ),
    };
  }
  const availabilities = state.hosts.flatMap((host) =>
    host.platforms
      .filter((candidate) => candidate.platform === platform)
      .map((candidate) => ({ ...candidate, host })),
  );
  const supportingHosts = availabilities
    .filter((candidate) => candidate.available)
    .map((candidate) => candidate.host);
  if (supportingHosts.length === 0) {
    return {
      ready: false,
      message:
        availabilities[0]?.reason ??
        resolve(msg("{platform} support was not detected.", { platform: platformName(platform) })),
    };
  }
  const readyHosts = supportingHosts.filter(
    (host) =>
      state.hostStatuses[host.id]?.status === "ready" ||
      (host.kind === "local" && state.hostStatus === "ready"),
  );
  if (readyHosts.length > 0 && !hasDevices) {
    if (
      readyHosts.some((host) =>
        state.hostStatuses[host.id]?.incompletePlatforms?.includes(platform),
      )
    ) {
      return {
        ready: false,
        message: resolve(
          msg("No {platform} devices were listed because device discovery reported a problem.", {
            platform: platformName(platform),
          }),
        ),
      };
    }
    return {
      ready: false,
      message:
        platform === "ios"
          ? resolve(
              msg(
                "Xcode is installed, but no iOS Simulator is available. Install a runtime in Xcode Settings → Components.",
              ),
            )
          : resolve(
              msg(
                "The Android SDK is installed, but no Android device was found. Connect a phone with USB debugging on, or create a virtual device in Android Studio → Device Manager.",
              ),
            ),
    };
  }
  const remoteHost = supportingHosts.every((host) => host.kind !== "local")
    ? supportingHosts[0]
    : undefined;
  const host = remoteHost?.label;
  return {
    ready: true,
    message:
      remoteHost?.kind === "eas"
        ? platform === "ios"
          ? resolve(
              msg("{host} starts iOS Simulators in the cloud with Expo Simulators.", { host }),
            )
          : resolve(
              msg("{host} starts Android emulators in the cloud with Expo Simulators.", { host }),
            )
        : platform === "ios"
          ? host
            ? resolve(msg("Xcode and iOS Simulator are available on {host}.", { host }))
            : resolve(msg("Xcode and iOS Simulator are available."))
          : host
            ? resolve(msg("The Android SDK and Emulator are available on {host}.", { host }))
            : resolve(msg("The Android SDK is available.")),
  };
}

/**
 * The device setup steps. `dialog` renders them inside a `WizardPopup`; `pane`
 * renders them as a Device tab's own content, which its tab closes instead of Cancel.
 */
export function DeviceSetup(props: {
  readonly environmentId: EnvironmentId;
  readonly state: DeviceServiceState;
  readonly onComplete?: () => void;
  readonly layout?: "dialog" | "pane";
}) {
  const canConfigure = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const gt = useGT();
  const m = useMessages();
  const configure = useAtomCommand(deviceEnvironment.configure);
  const list = useAtomCommand(deviceEnvironment.list, { reportFailure: false });
  const [pending, setPending] = useState<"hub" | "check" | "agent" | "complete" | null>(null);
  const [step, setStep] = useState(0);
  const enabled = props.state.hostStatus !== "disabled";
  const { ready, busy } = deviceHubReadiness(props.state);
  const localPlatformsUnavailable = props.state.hosts.some(
    (host) => host.kind === "local" && !host.platforms.some((platform) => platform.available),
  );

  useAtomMount(enabled ? deviceHostProbeAtom(props.environmentId) : NO_DEVICE_PROBE_ATOM);

  const update = async (
    kind: NonNullable<typeof pending>,
    input: { enabled?: boolean; agentAccessEnabled?: boolean; onboardingCompleted?: boolean },
  ) => {
    if (!readEnvironmentScope(props.environmentId, AuthSettingsWriteScope)) return;
    setPending(kind);
    const result = await configure({ environmentId: props.environmentId, input });
    setPending(null);
    if (kind === "complete" && result._tag === "Success") props.onComplete?.();
  };

  const title = gt("Set up devices");
  const description = gt(
    "Review what runs on this environment before using simulators and emulators.",
  );
  const steps = (
    <WizardSteps
      steps={[gt("Device hub"), gt("Simulators"), gt("Agent access")]}
      currentStep={step}
      onStepChange={setStep}
      isStepDisabled={(requested) => busy || pending !== null || requested > step}
    />
  );
  const body = (
    <>
      <DeviceHostUpdates state={props.state} environmentId={props.environmentId} />
      {step === 0 ? (
        <section className="space-y-3 text-sm">
          <h3 className="font-medium">
            <T>Enable the device hub</T>
          </h3>
          <div className="flex items-start justify-between gap-4">
            <p className="text-muted-foreground">{m(deviceHubDescription)}</p>
            <Switch
              checked={enabled}
              disabled={!canConfigure || busy || pending !== null}
              aria-label={gt("Enable device hub")}
              onCheckedChange={(checked) =>
                void update("hub", {
                  enabled: Boolean(checked),
                  ...(checked ? {} : { agentAccessEnabled: false }),
                })
              }
            />
          </div>
          <DeviceHubSetupStatus
            state={props.state}
            pending={pending === "hub" || (busy && pending !== "agent")}
          />
        </section>
      ) : null}

      {step === 1 || (step === 0 && enabled && localPlatformsUnavailable) ? (
        <section className={cn("space-y-3 text-sm", step === 0 && "mt-4")}>
          <h3 className="font-medium">
            <T>Check simulator support</T>
          </h3>
          <DevicePlatformSetup
            state={props.state}
            checking={pending === "check"}
            disabled={!enabled || busy || pending !== null}
            onCheck={() => {
              setPending("check");
              void list({ environmentId: props.environmentId, input: {} }).finally(() =>
                setPending(null),
              );
            }}
          />
        </section>
      ) : null}

      {step === 2 ? (
        <section className="space-y-3 text-sm">
          <h3 className="font-medium">
            <T>Allow agent control</T>
          </h3>
          <div className="flex items-start justify-between gap-4">
            <p className="text-muted-foreground">{m(agentDeviceDescription)}</p>
            <Switch
              checked={props.state.agentAccessEnabled}
              disabled={!canConfigure || !enabled || busy || pending !== null}
              aria-label={gt("Allow agents to control devices")}
              onCheckedChange={(checked) =>
                void update("agent", { agentAccessEnabled: Boolean(checked) })
              }
            />
          </div>
          <AgentDeviceSetupStatus state={props.state} pending={pending === "agent"} />
          <p className="text-xs text-muted-foreground">
            <T>Leave this off to keep manual device controls without giving agents access.</T>
          </p>
        </section>
      ) : null}
      {props.state.hostStatus === "failed" && props.state.hostStatusDetail ? (
        <p role="alert" className="mt-3 text-xs text-error-foreground">
          {props.state.hostStatusDetail}
        </p>
      ) : null}
    </>
  );
  const back =
    step === 0 ? null : (
      <Button
        variant="secondary"
        disabled={busy || pending !== null}
        onClick={() => setStep(step - 1)}
      >
        <T>Back</T>
      </Button>
    );
  const next =
    step < 2 ? (
      <Button disabled={!ready || pending !== null} onClick={() => setStep(step + 1)}>
        <T>Continue</T>
      </Button>
    ) : (
      <Button
        disabled={!canConfigure || !ready || pending !== null}
        onClick={() => void update("complete", { onboardingCompleted: true })}
      >
        {pending === "complete" ? gt("Saving…") : gt("Done")}
      </Button>
    );

  if (props.layout === "pane") {
    return (
      <div className="scrollbar-gutter-both flex h-full min-h-0 overflow-y-auto px-4 pt-4 pb-6">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-4.5">
          <PreviewEmptyHero icon={<Smartphone />} title={title} description={description} strong>
            {steps}
          </PreviewEmptyHero>
          <div className="rounded-card surface-card-settings px-4 py-4">{body}</div>
          <div className="flex flex-wrap justify-end gap-2">
            {back}
            {next}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <WizardHeader title={title} description={description}>
        {steps}
      </WizardHeader>
      <WizardPanel>{body}</WizardPanel>
      <WizardFooter>
        {back ?? (
          <DialogClose render={<Button variant="secondary" />}>
            <T>Cancel</T>
          </DialogClose>
        )}
        {next}
      </WizardFooter>
    </>
  );
}

export function DeviceHubSetupStatus({
  state,
  pending,
  compact = false,
}: {
  readonly state: DeviceServiceState;
  readonly pending: boolean;
  readonly compact?: boolean;
}) {
  const gt = useGT();
  if (!pending && !deviceHubReadiness(state).ready) return null;
  return (
    <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
      {pending ? <Spinner size="xs" /> : <Check className="size-3 text-success-foreground" />}
      {pending
        ? state.hostStatus === "installing"
          ? compact
            ? gt("Installing…")
            : gt("Installing device hub…")
          : state.hostStatus === "starting"
            ? compact
              ? gt("Starting…")
              : gt("Starting device hub…")
            : compact
              ? gt("Updating…")
              : gt("Updating device hub…")
        : gt("Device hub is ready.")}
    </p>
  );
}

function DevicePlatformSetup(props: {
  readonly state: DeviceServiceState;
  readonly checking: boolean;
  readonly disabled: boolean;
  readonly onCheck: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  return (
    <div className="space-y-3">
      <PlatformStatus platform="iOS" status={platformSetupStatus(props.state, "ios", m)} />
      <PlatformStatus platform="Android" status={platformSetupStatus(props.state, "android", m)} />
      <DeviceHostDiagnostics hosts={props.state.hosts} hostStatuses={props.state.hostStatuses} />
      <p className="text-xs text-muted-foreground">
        <T>You can use either platform. Fixing a missing platform does not block the other one.</T>
      </p>
      <Button size="compact" variant="secondary" disabled={props.disabled} onClick={props.onCheck}>
        {props.checking ? <Spinner size="xs" /> : null}
        {props.checking ? gt("Checking…") : gt("Check again")}
      </Button>
    </div>
  );
}

export function AgentDeviceSetupStatus(props: {
  readonly state: DeviceServiceState;
  readonly pending: boolean;
  readonly compact?: boolean;
}) {
  const gt = useGT();
  if (props.pending) {
    const label =
      props.state.hostStatus === "installing"
        ? props.compact
          ? gt("Installing…")
          : gt("Installing agent tools…")
        : props.state.hostStatus === "starting"
          ? props.compact
            ? gt("Starting…")
            : gt("Starting agent tools…")
          : props.compact
            ? gt("Updating…")
            : gt("Updating agent access…");
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner size="xs" />
        {label}
      </p>
    );
  }
  if (
    props.state.agentAccessEnabled &&
    deviceHubReadiness(props.state).ready &&
    props.state.hosts.some((host) => host.agentDeviceInstalled)
  ) {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Check className="size-3 text-success-foreground" />
        <T>Agent tools are ready.</T>
      </p>
    );
  }
  return null;
}

function PlatformStatus(props: {
  readonly platform: string;
  readonly status: { readonly ready: boolean; readonly message: string };
  readonly compact?: boolean;
}) {
  const gt = useGT();
  return (
    <div className={cn("flex gap-2", !props.compact && "rounded-card surface-panel px-3 py-2")}>
      {props.status.ready ? (
        <Check
          className={cn(
            "mt-0.5 size-4 shrink-0",
            props.status.ready ? "text-success-foreground" : "text-muted-foreground",
          )}
        />
      ) : (
        <CircleAlert
          className={cn(
            "mt-0.5 size-4 shrink-0",
            props.status.ready ? "text-success-foreground" : "text-muted-foreground",
          )}
        />
      )}
      <div className={cn(props.compact && props.status.ready && "flex items-center gap-2")}>
        <p className="font-medium">{props.platform}</p>
        <p className="text-xs text-muted-foreground">
          {props.compact && props.status.ready
            ? gt("Ready", { $context: "platform status" })
            : props.status.message}
        </p>
      </div>
    </div>
  );
}
