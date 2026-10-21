import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type {
  DeviceActionInput,
  DeviceDetail,
  DeviceSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { deviceEnvironment } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { subscribeDeviceForeground, type DeviceForegroundInfo } from "./deviceHubApi";

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
  const readDetail = useAtomCommand(deviceEnvironment.detail, { reportFailure: false });
  const runAction = useAtomCommand(deviceEnvironment.action, { reportFailure: false });
  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [foreground, setForeground] = useState<DeviceForegroundInfo | null | undefined>();
  // Hiding invalidates results without cancelling host commands; serialize through settlement across reopen.
  const busy = useRef(false);
  const generation = useRef(0);
  const visibleRead = useRef<Parameters<typeof readDetail>[0] | null>(null);
  const { hostId, id: deviceId } = device;

  useEffect(() => {
    const revision = ++generation.current;
    if (!visible) return;
    const request = { environmentId, input: { hostId, deviceId } };
    visibleRead.current = request;
    void readDetail(request).then((result) => {
      if (generation.current !== revision) return;
      if (result._tag === "Success") {
        setDetail(result.value);
        setError(null);
      } else {
        setDetail(null);
        setError(formatEnvironmentQueryError(result.cause));
      }
    });
    return () => {
      visibleRead.current = null;
      generation.current++;
    };
  }, [deviceId, environmentId, hostId, readDetail, visible]);

  useEffect(() => {
    if (!access || !visible) return;
    let active = true;
    const unsubscribe = subscribeDeviceForeground(
      { access, platform: device.platform, deviceId: device.id },
      (app) => {
        if (active) setForeground(app);
      },
    );
    return () => {
      active = false;
      unsubscribe();
      setForeground(undefined);
    };
  }, [access, device.id, device.platform, visible]);

  const available = detail !== null && visible;
  const act = async (body: ActionBody) => {
    if (busy.current || !available) return;
    busy.current = true;
    const revision = ++generation.current;
    setPending(true);
    setError(null);
    return runAction({
      environmentId,
      input: { hostId, deviceId, ...body } as DeviceActionInput,
    })
      .then((result) => {
        if (generation.current !== revision) {
          const request = visibleRead.current;
          if (!request) return;
          // Reopening can read before pending commands settle; refresh again before allowing actions.
          const refreshRevision = ++generation.current;
          return readDetail(request).then((refreshed) => {
            if (generation.current !== refreshRevision) return;
            if (refreshed._tag === "Success") {
              setDetail(refreshed.value);
              setError(null);
            } else {
              setDetail(null);
              setError(formatEnvironmentQueryError(refreshed.cause));
            }
          });
        }
        if (result._tag === "Success") setDetail(result.value);
        else setError(formatEnvironmentQueryError(result.cause));
      })
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
