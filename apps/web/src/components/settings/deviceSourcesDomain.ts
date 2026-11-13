import { useAtomValue } from "@effect/atom-react";
import { Fragment, useState, type ReactNode } from "react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  AuthSettingsWriteScope,
  type DevicePlatform,
  type DevicePlatformAvailability,
  type DeviceServiceState,
  type EasDeviceHostConfig,
  type EnvironmentId,
  type ServerSettingsPatch,
  type SimlockDeviceHostConfig,
  type SshDeviceHostConfig,
} from "@t3tools/contracts";
import { ChevronDownIcon, MoreVertical, PlusIcon } from "lucide-react";

import { cn, randomUUID } from "../../lib/utils";
import { deviceEnvironment } from "../../state/device";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { AndroidIcon, AppleIcon } from "../Icons";
import { Button, InlineButton } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { DeviceHostEditor } from "./DeviceHostEditor";
import { updateDeviceHosts, groupDeviceHosts } from "./deviceHostsSettings.logic";
import { EasDeviceHostEditor } from "./EasDeviceHostEditor";
import {
  easSessionLimits,
  newEasDeviceHost,
  updateEasDeviceHosts,
} from "./easDeviceHostsSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsSection } from "./settingsLayout";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { SimlockDeviceHostEditor } from "./SimlockDeviceHostEditor";
import {
  newSimlockDeviceHost,
  planSimlockDeviceHostSave,
  simlockLeaseLimits,
  updateSimlockDeviceHosts,
  type SimlockTokenEntry,
} from "./simlockDeviceHostsSettings.logic";
import { useHostConnectionChecks } from "./useHostConnectionChecks";

export const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/** Something on one environment that is in progress or needs a fix; a working source has none. */
export interface SourceStatus {
  readonly tone: "pending" | "warning" | "error";
  readonly label: string;
  readonly detail?: string | undefined;
  readonly action?: { readonly label: string; readonly run: () => void } | undefined;
}

/** A source on one environment whose devices are on. */
export interface SourceEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly added: boolean;
  readonly status?: SourceStatus | undefined;
  /** Unknown until the environment's hub has reached the source. */
  readonly platforms?: ReadonlyArray<DevicePlatformAvailability> | undefined;
}

export interface SourceRow {
  readonly key: string;
  readonly title: string;
  readonly kind?: string;
  readonly description: ReactNode;
  readonly environments: ReadonlyArray<SourceEnvironment>;
  /**
   * One machine or account every environment reaches the same way (an SSH host, EAS, a Simlock
   * pool), so its platforms are the same for all of them. Local simulators differ per machine.
   */
  readonly shared: boolean;
  readonly actions?: ReactNode;
}

export type Editing =
  | {
      readonly kind: "ssh";
      readonly host: SshDeviceHostConfig;
      readonly original: SshDeviceHostConfig | null;
      /** Limits the save to these environments, for a host that differs between them. */
      readonly only?: ReadonlySet<EnvironmentId>;
    }
  | {
      readonly kind: "eas";
      readonly host: EasDeviceHostConfig;
      readonly isNew: boolean;
      /** Where the editor checks the Expo account: an environment that holds the host. */
      readonly environmentId: EnvironmentId;
    }
  | { readonly kind: "simlock"; readonly host: SimlockDeviceHostConfig; readonly isNew: boolean };

/** What a configured host is doing on one environment, when it is not simply working. */
export function hostStatus(
  state: DeviceServiceState | undefined,
  hostId: string,
): SourceStatus | undefined {
  if (!state) return { tone: "pending", label: "Loading" };
  const status = state.hostStatuses[hostId];
  switch (status?.status) {
    case "ready":
      return status.androidDiscoveryIncomplete
        ? { tone: "warning", label: "Android list may be incomplete", detail: status.detail }
        : undefined;
    case "installing":
    case "starting":
      return { tone: "pending", label: "Starting", detail: status.detail };
    case "failed":
      return { tone: "error", label: "Failed", detail: status.detail };
    default:
      return undefined;
  }
}

export const hostPlatforms = (state: DeviceServiceState | undefined, hostId: string) =>
  state?.hosts.find((host) => host.id === hostId)?.platforms;

/**
 * Every device source the selected environments can open, one row each. A source configured on
 * several environments is one row; how it stands on each lives in the row's breakdown.
 */
