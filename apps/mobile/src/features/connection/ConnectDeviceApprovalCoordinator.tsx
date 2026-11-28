import { msg } from "gt-react-native";
import { unseenConnectDevices } from "@t3tools/client-runtime/connect-device-notices";
import {
  AuthAccessWriteScope,
  type AuthConnectDevice,
  type AuthPairingLink,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Fragment, useEffect, useEffectEvent } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { loadPreferences, updatePreferences } from "../../persistence/imperative";
import { authEnvironment } from "../../state/auth";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type ConnectDeviceApprovalPrompt,
  connectDeviceApprovalPrompts,
  createApprovalPromptQueue,
  describeConnectDevice,
} from "./connectDeviceApproval";

/**
 * Asks to approve T3 Connect devices waiting on hosts that require it and this phone manages,
 * and tells it about devices that got in on hosts that do not.
 */
export function ConnectDeviceApprovalCoordinator() {
  const { environments } = useEnvironments();
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== undefined,
  );
  const managed = useEnvironmentsWithScope(connected, AuthAccessWriteScope);
  return (
    <>
      {connected
        .filter((environment) => managed.has(environment.environmentId))
        .map((environment) => {
          const approvalRequired =
            environment.serverConfig?.settings.requireConnectDeviceApproval === true;
          return (
            <Fragment key={environment.environmentId}>
              {approvalRequired ? (
                <EnvironmentApprovalWatcher
                  environmentId={environment.environmentId}
                  environmentLabel={environment.label}
                />
              ) : null}
              <NewConnectDeviceWatcher
                environmentId={environment.environmentId}
                environmentLabel={environment.label}
                announce={!approvalRequired}
              />
            </Fragment>
          );
        })}
    </>
  );
}

interface NewDeviceNotice {
  /** Keys the queue; a later notice for the same host carries a newer watermark. */
  readonly pairingLinkId: string;
  readonly environmentId: EnvironmentId;
}

/** The latest device list per watched host, read when a notice shows so it names only unseen devices. */
const announcedHosts = new Map<
  EnvironmentId,
  { readonly label: string; readonly devices: ReadonlyArray<AuthConnectDevice> }
>();

const loadSeenThrough = async (environmentId: EnvironmentId) => {
  const preferences = await loadPreferences().catch(() => null);
  return preferences === null
    ? null
    : { seenThrough: preferences.connectDevicesSeenThrough?.[environmentId] };
};

const markConnectDevicesSeen = (environmentId: EnvironmentId, newest: number) =>
  updatePreferences((current) => ({
    connectDevicesSeenThrough: {
      ...current.connectDevicesSeenThrough,
      [environmentId]: Math.max(current.connectDevicesSeenThrough?.[environmentId] ?? 0, newest),
    },
  })).catch(() => undefined);

const newDeviceNotices = createApprovalPromptQueue<NewDeviceNotice>((notice, answer) => {
  void (async () => {
    const host = announcedHosts.get(notice.environmentId);
    const seen = host ? await loadSeenThrough(notice.environmentId) : null;
    const current = announcedHosts.get(notice.environmentId);
    if (!current || seen === null || seen.seenThrough === undefined) return answer("done");
    const { unseen, newest } = unseenConnectDevices(current.devices, seen.seenThrough);
    if (unseen.length === 0) return answer("done");
    const [firstDevice = ""] = unseen.map(({ client: device }) => describeConnectDevice(device));
    Dialog.alert(
      m(msg("New device signed in to {environment}", { environment: current.label })),
      unseen.length === 1
        ? m(
            msg(
              "{device} connected through {product}. If this was not you, remove it in Settings → Access in T3 Code on that computer.",
              { device: firstDevice, product: "T3 Connect" },
            ),
          )
        : m(
            msg(
              "{count, plural, one {{count} device} other {{count} devices}} connected through {product}. If this was not you, remove them in Settings → Access in T3 Code on that computer.",
              { count: unseen.length, product: "T3 Connect" },
            ),
          ),
      [
        {
          text: m(msg("OK")),
          onPress: () => {
            void markConnectDevicesSeen(notice.environmentId, newest).then(() => answer("done"));
          },
        },
      ],
      // Another dialog took the screen; the notice shows again on the next update.
      { onDismiss: () => answer("later") },
    );
  })();
});

/** Devices approved by hand are already known, so only `announce` hosts that skip approval. */
function NewConnectDeviceWatcher(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly announce: boolean;
}) {
  const access = useEnvironmentQuery(
    authEnvironment.accessChanges({ environmentId: props.environmentId, input: null }),
  );
  // Older servers omit the list.
  const devices = access.data?.type === "snapshot" ? access.data.payload.connectDevices : undefined;

  const check = useEffectEvent(async (current: ReadonlyArray<AuthConnectDevice>) => {
    announcedHosts.set(props.environmentId, { label: props.environmentLabel, devices: current });
    const seen = await loadSeenThrough(props.environmentId);
    // The host went away while preferences loaded.
    if (seen === null || announcedHosts.get(props.environmentId)?.devices !== current) return;
    const { unseen, newest } = unseenConnectDevices(current, seen.seenThrough);
    if (!props.announce || unseen.length === 0) {
      if (seen.seenThrough !== newest) await markConnectDevicesSeen(props.environmentId, newest);
      return;
    }
    newDeviceNotices.offer([
      { pairingLinkId: `${props.environmentId}:${newest}`, environmentId: props.environmentId },
    ]);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a device this phone has not announced opens a native alert
  useEffect(() => {
    if (devices !== undefined) void check(devices);
  }, [devices]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- forgets this host and drops its queued notice when it goes away
  useEffect(() => {
    const environmentId = props.environmentId;
    return () => {
      announcedHosts.delete(environmentId);
      newDeviceNotices.drop((notice) => notice.environmentId === environmentId);
    };
  }, [props.environmentId]);

  return null;
}

/** "gone": the request expired or was answered elsewhere before this answer arrived. */
type ApprovalAnswer = "done" | "failed" | "gone";

interface QueuedApprovalPrompt extends ConnectDeviceApprovalPrompt {
  readonly environmentId: EnvironmentId;
  readonly approve: () => Promise<ApprovalAnswer>;
  readonly deny: () => Promise<ApprovalAnswer>;
}

const watchedEnvironments = new Set<EnvironmentId>();

// One queue for every host: a second Android alert would replace an unanswered first one.
const approvalPrompts = createApprovalPromptQueue<QueuedApprovalPrompt>((prompt, answer) => {
  const respond = (action: () => Promise<ApprovalAnswer>, failure: string) => () =>
    void action().then((outcome) => {
      // A host that went away or lost access cannot be retried; let the next prompt show.
      if (outcome === "done" || !watchedEnvironments.has(prompt.environmentId)) {
        return answer("done");
      }
      if (outcome === "gone") {
        return Dialog.alert(
          m(msg("Request no longer waiting")),
          m(msg("It expired or was answered elsewhere.")),
          [{ text: m(msg("OK")), onPress: () => answer("done") }],
          { onDismiss: () => answer("done") },
        );
      }
      const retryIfWatched = () =>
        answer(watchedEnvironments.has(prompt.environmentId) ? "retry" : "done");
      Dialog.alert(
        failure,
        m(msg("The request is still waiting. Try again.")),
        [{ text: m(msg("OK")), onPress: retryIfWatched }],
        // Another dialog took the screen; offer the request again on the next update.
        { onDismiss: () => answer("later") },
      );
    });
  Dialog.alert(
    prompt.title,
    prompt.message,
    [
      {
        text: m(msg("Deny")),
        onPress: respond(prompt.deny, m(msg("Could not deny the device"))),
      },
      {
        text: m(msg("Approve")),
        onPress: respond(prompt.approve, m(msg("Could not approve the device"))),
      },
    ],
    // Another dialog took the screen; offer the request again on the next update.
    { cancelable: false, onDismiss: () => answer("later") },
  );
});

function EnvironmentApprovalWatcher(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const access = useEnvironmentQuery(
    authEnvironment.accessChanges({ environmentId: props.environmentId, input: null }),
  );
  const approve = useAtomCommand(authEnvironment.approveConnectDevice, { reportFailure: false });
  const deny = useAtomCommand(authEnvironment.revokePairingLink, { reportFailure: false });
  const pairingLinks =
    access.data?.type === "snapshot" ? access.data.payload.pairingLinks : undefined;

  const offerPrompts = useEffectEvent((links: ReadonlyArray<AuthPairingLink>) => {
    const prompts = connectDeviceApprovalPrompts({
      environmentLabel: props.environmentLabel,
      pairingLinks: links,
      shownIds: approvalPrompts.known,
    });
    approvalPrompts.offer(
      prompts.map((prompt) => ({
        ...prompt,
        environmentId: props.environmentId,
        approve: () =>
          approve({
            environmentId: props.environmentId,
            input: { pairingLinkId: prompt.pairingLinkId },
          }).then((result) =>
            result._tag !== "Success" ? "failed" : result.value.approved ? "done" : "gone",
          ),
        deny: () =>
          deny({ environmentId: props.environmentId, input: { id: prompt.pairingLinkId } }).then(
            (result) =>
              result._tag !== "Success" ? "failed" : result.value.revoked ? "done" : "gone",
          ),
      })),
    );
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this host with the module-level prompt queue and drops its prompts when it goes away
  useEffect(() => {
    const environmentId = props.environmentId;
    watchedEnvironments.add(environmentId);
    return () => {
      watchedEnvironments.delete(environmentId);
      approvalPrompts.drop((prompt) => prompt.environmentId === environmentId);
    };
  }, [props.environmentId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new request on the access stream opens a native alert
  useEffect(() => {
    if (pairingLinks !== undefined) offerPrompts(pairingLinks);
  }, [pairingLinks]);

  return null;
}
