import { useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { DeviceActionInput, DeviceSummary, EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { deviceDetailAtom, deviceDetailReadAtom, deviceEnvironment } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { deviceForegroundAtom, NO_FOREGROUND_ATOM, NOOP_ATOM } from "./deviceHubAtoms";

type ActionBody = DeviceActionInput extends infer A
  ? A extends { readonly type: string }
    ? Omit<A, "hostId" | "deviceId">
    : never
  : never;

/** Mount keyed by device. */
export function useDeviceControls(options: {
  environmentId: EnvironmentId;
  device: DeviceSummary;
  access: DeviceHubAccess | null;
  visible: boolean;
}) {
  const { environmentId, device, access, visible } = options;
  const runAction = useAtomCommand(deviceEnvironment.action, { reportFailure: false });
  const { hostId, id: deviceId } = device;
  const key = { environmentId, hostId, deviceId };
  const { detail, error } = useAtomValue(deviceDetailAtom(key));
  const setView = useAtomSet(deviceDetailAtom(key));
  useAtomMount(visible ? deviceDetailReadAtom(key) : NOOP_ATOM);
  const foreground = useAtomValue(
    access && visible
      ? deviceForegroundAtom({ access, platform: device.platform, deviceId })
      : NO_FOREGROUND_ATOM,
  );
  const [pending, setPending] = useState(false);
  // Hiding does not cancel host commands, so actions stay serialized until settlement
  // rather than letting a reopened panel race the previous command.
  const busy = useRef(false);

  const available = detail !== null && visible;
  const act = async (body: ActionBody) => {
    if (busy.current || !available) return;
    busy.current = true;
    setPending(true);
    setView((current) => ({ ...current, error: null }));
    return runAction({
      environmentId,
      input: { hostId, deviceId, ...body } as DeviceActionInput,
    })
      .then((result) =>
        setView((current) =>
          result._tag === "Success"
            ? { detail: result.value, error: null }
            : { ...current, error: formatEnvironmentQueryError(result.cause) },
        ),
      )
      .finally(() => {
        busy.current = false;
        setPending(false);
      });
  };

  return {
    detail,
    pending,
    error,
    act,
    disabled: pending || !detail || !visible,
    foregroundApp: foreground === undefined ? (detail?.foregroundApp ?? null) : foreground,
  };
}

export type DeviceControls = ReturnType<typeof useDeviceControls>;
