import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import { useRef, useState } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { SshDeviceHostConfig } from "@t3tools/contracts";
import { useT } from "../../hooks/useI18n";
import { deviceEnvironment } from "../../state/device";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  checkDeviceHostConnections,
  deviceHostConnectionKey,
  type DeviceHostCheck,
  type DeviceHostCheckTarget,
} from "./deviceHostConnectionChecks";

export function useHostConnectionChecks(targets: ReadonlyArray<DeviceHostCheckTarget>) {
  const t = useT();
  const test = useAtomCommand(deviceEnvironment.testHost, { reportFailure: false });
  const [checks, setChecks] = useState<Record<string, Record<string, DeviceHostCheck>>>({});
  const running = useRef(new Set<string>());
  const testConnection = async (host: SshDeviceHostConfig) => {
    const key = deviceHostConnectionKey(host);
    if (running.current.has(key)) return;
    running.current.add(key);
    setChecks((current) => ({ ...current, [key]: {} }));
    const results: Record<string, DeviceHostCheck> = {};
    await checkDeviceHostConnections(
      targets,
      host,
      async (environmentId, input) => {
        if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
          throw new Error(t("settings.code.deviceHost.cannotTest"));
        }
        const result = await test({ environmentId, input });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      },
      (environmentId, result) => {
        results[environmentId] = result;
        setChecks((current) => ({
          ...current,
          [key]: { ...current[key], [environmentId]: result },
        }));
      },
      t,
    ).finally(() => running.current.delete(key));
    return results;
  };
  return { checks, testConnection };
}
