import type { EnvironmentId } from "@t3tools/contracts";
import { msg } from "gt-react";
import { PinIcon, RotateCwIcon, SquareIcon } from "lucide-react";
import type { MessageResolver } from "~/i18n/messages";
import {
  canRetryPinnedPortForward,
  retryPinnedPortForward,
  type PinnedPortForwardState,
  unpinPortForward,
} from "~/state/pinnedPortForwards";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "../CommandPalette.logic";
import { openPinPortForwardDialog, type PinPortForwardTarget } from "./PinPortForwardDialog";
import { pinnedPortLabel, pinnedPortMapping, pinnedPortStatusText } from "./pinnedPortForwardCopy";

export function pinPortForwardAction(
  target: PinPortForwardTarget,
  title: string,
): CommandPaletteActionItem {
  return {
    kind: "action",
    value: `port-forward:pin:${target.environmentId}:${target.remotePort}`,
    title,
    searchTerms: [
      String(target.remotePort),
      target.environmentLabel,
      "pin",
      "always forward",
      "portless",
    ],
    icon: <PinIcon className={ITEM_ICON_CLASS} />,
    run: async () => openPinPortForwardDialog(target),
  };
}

function pinnedPortForwardItem(
  pin: PinnedPortForwardState,
  environment: string,
  resolve: MessageResolver,
): CommandPaletteSubmenuItem {
  const title = pinnedPortLabel(pin, resolve);
  const status = pinnedPortStatusText(pin, environment, resolve);
  const mapping = pinnedPortMapping(environment, pin.remotePort, resolve);
  const actions: CommandPaletteActionItem[] = [];
  if (canRetryPinnedPortForward(pin.status)) {
    actions.push({
      kind: "action",
      value: "port-forward:retry-pin",
      title: resolve(msg("Retry auto-forward")),
      searchTerms: ["retry", "forward"],
      icon: <RotateCwIcon className={ITEM_ICON_CLASS} />,
      run: async () => retryPinnedPortForward(pin.environmentId, pin.remotePort),
    });
  }
  actions.push({
    kind: "action",
    value: "port-forward:unpin",
    title: resolve(msg("Stop auto-forwarding")),
    searchTerms: ["stop", "remove", "unpin"],
    icon: <SquareIcon className={ITEM_ICON_CLASS} />,
    run: () => unpinPortForward(pin.environmentId, pin.remotePort),
  });
  return {
    kind: "submenu",
    value: `port-forward:pinned:${pin.environmentId}:${pin.remotePort}`,
    title,
    description: `${status} · ${mapping}`,
    searchTerms: [title, String(pin.remotePort), environment, "pinned", "always forward"],
    icon: <PinIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <PinIcon className={ADDON_ICON_CLASS} />,
    groups: [{ value: "pinned-port-forward-actions", label: title, items: actions }],
  };
}

export function pinnedPortForwardGroup(
  value: string,
  pins: ReadonlyArray<PinnedPortForwardState>,
  labelOf: (environmentId: EnvironmentId) => string,
  resolve: MessageResolver,
): CommandPaletteGroup {
  return {
    value,
    label: resolve(msg("Auto-forwards")),
    items: pins.map((pin) => pinnedPortForwardItem(pin, labelOf(pin.environmentId), resolve)),
  };
}
