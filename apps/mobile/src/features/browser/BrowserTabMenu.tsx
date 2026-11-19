import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import {
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  type EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  PREVIEW_ZOOM_LEVELS,
  type PreviewAdjustInput,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import { PREVIEW_VIEWPORT_PRESETS } from "@t3tools/shared/previewViewport";
import { msg, useGT, useMessages } from "gt-react-native";

import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { m } from "../../i18n/messages";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { browserTabUrl, loopbackUrlForDevice } from "./browserTabs";
import { useOpenLocalPreview } from "./useOpenLocalPreview";

const APPEARANCES = [
  {
    id: "system",
    title: msg("System", { $context: "appearance option, follow the system theme" }),
  },
  { id: "light", title: msg("Light", { $context: "appearance option" }) },
  { id: "dark", title: msg("Dark", { $context: "appearance option" }) },
] as const;

const VIEWPORTS = [
  { id: "fill", title: msg("Fit to screen"), setting: FILL_PREVIEW_VIEWPORT },
  ...(["Phone", "Tablet", "Desktop"] as const).flatMap((category) => {
    const preset = PREVIEW_VIEWPORT_PRESETS.find((candidate) => candidate.category === category);
    if (!preset) return [];
    const setting: PreviewViewportSetting = {
      _tag: "preset",
      presetId: preset.id,
      width: preset.width,
      height: preset.height,
    };
    const title =
      category === "Phone"
        ? msg("Phone ({device})", { device: preset.label })
        : category === "Tablet"
          ? msg("Tablet ({device})", { device: preset.label })
          : msg("Desktop ({device})", { device: preset.label });
    return [{ id: `preset:${preset.id}`, title, setting }];
  }),
];

export function BrowserTabMenu({
  environmentId,
  tab,
  streaming,
  onPaste,
  onReleaseControl,
}: {
  readonly environmentId: EnvironmentId;
  readonly tab: PreviewSessionSnapshot;
  readonly streaming: boolean;
  readonly onPaste?: () => void;
  readonly onReleaseControl?: () => void;
}) {
  const openLocalPreview = useOpenLocalPreview();
  const adjust = useAtomCommand(previewEnvironment.adjust, "browser tab change");
  const resize = useAtomCommand(previewEnvironment.resize, "browser viewport change");
  const close = useAtomCommand(previewEnvironment.close, "browser tab close");
  const canClose = useAtomValue(previewEnvironment.close.permissionAtom(environmentId));
  const gt = useGT();
  const resolveMessage = useMessages();
  const target = { threadId: tab.threadId as PreviewAdjustInput["threadId"], tabId: tab.tabId };
  const colorScheme = tab.colorScheme ?? "system";
  const zoomFactor = tab.zoomFactor ?? DEFAULT_PREVIEW_ZOOM_FACTOR;
  const zoomIndex = PREVIEW_ZOOM_LEVELS.indexOf(zoomFactor);
  const zoomTo = (step: -1 | 1) =>
    PREVIEW_ZOOM_LEVELS[
      Math.min(Math.max((zoomIndex < 0 ? 7 : zoomIndex) + step, 0), PREVIEW_ZOOM_LEVELS.length - 1)
    ]!;
  const viewportId =
    tab.viewport === undefined || tab.viewport._tag === "fill"
      ? "fill"
      : tab.viewport._tag === "preset"
        ? `preset:${tab.viewport.presetId}`
        : "custom";

  const closeAction: MenuAction = {
    id: "close",
    title: gt("Close tab"),
    image: "xmark",
    attributes: { destructive: true, disabled: !canClose },
  };
  const deviceUrl = loopbackUrlForDevice(browserTabUrl(tab));
  const actions: MenuAction[] = [
    ...(deviceUrl
      ? [{ id: "open-on-device", title: gt("Open on this device"), image: "iphone" }]
      : []),
    ...(onPaste
      ? [{ id: "paste", title: gt("Paste", { $context: "verb" }), image: "doc.on.clipboard" }]
      : []),
    ...(onReleaseControl
      ? [{ id: "release-control", title: gt("Release control"), image: "hand.raised" }]
      : []),
    { id: "hard-reload", title: gt("Hard reload"), image: "arrow.clockwise.circle" },
    {
      id: "appearance",
      title: gt("Appearance"),
      image: "circle.lefthalf.filled",
      subactions: APPEARANCES.map((option) => ({
        id: `appearance:${option.id}`,
        title: resolveMessage(option.title),
        state: option.id === colorScheme ? "on" : "off",
      })),
    },
    {
      id: "zoom",
      title: gt("Zoom ({percent}%)", { percent: Math.round(zoomFactor * 100) }),
      image: "plus.magnifyingglass",
      subactions: [
        { id: "zoom:in", title: gt("Zoom in"), image: "plus.magnifyingglass" },
        { id: "zoom:out", title: gt("Zoom out"), image: "minus.magnifyingglass" },
        { id: "zoom:reset", title: gt("Actual size"), image: "1.magnifyingglass" },
      ],
    },
    {
      id: "viewport",
      title: gt("Viewport"),
      image: "rectangle.and.arrow.up.right.and.arrow.down.left",
      subactions: VIEWPORTS.map((option) => ({
        id: `viewport:${option.id}`,
        title: resolveMessage(option.title),
        state: option.id === viewportId ? "on" : "off",
      })),
    },
    {
      id: "site-data",
      title: gt("Site data"),
      image: "trash",
      subactions: [
        { id: "clear:cookies", title: gt("Clear cookies"), attributes: { destructive: true } },
        { id: "clear:cache", title: gt("Clear cache"), attributes: { destructive: true } },
      ],
    },
    closeAction,
  ];

  const run = async (change: Omit<PreviewAdjustInput, "threadId" | "tabId">) => {
    const result = await adjust({ environmentId, input: { ...target, ...change } });
    if (result._tag === "Failure") Dialog.alert(m(msg("Could not change this browser tab")));
  };

  const onAction = (id: string) => {
    if (id === "close") {
      void close({ environmentId, input: target }).then((result) => {
        if (result._tag === "Failure") Dialog.alert(m(msg("Could not close this browser tab")));
      });
      return;
    }
    if (id === "open-on-device" && deviceUrl) {
      return openLocalPreview({ environmentId, threadId: tab.threadId }, deviceUrl);
    }
    if (id === "paste") return onPaste?.();
    if (id === "release-control") return onReleaseControl?.();
    if (id === "hard-reload") return void run({ hardReload: true });
    if (id === "zoom:in") return void run({ zoomFactor: zoomTo(1) });
    if (id === "zoom:out") return void run({ zoomFactor: zoomTo(-1) });
    if (id === "zoom:reset") return void run({ zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR });
    if (id === "clear:cookies") return void run({ clear: "cookies" });
    if (id === "clear:cache") return void run({ clear: "cache" });
    if (id.startsWith("appearance:")) {
      const option = APPEARANCES.find((candidate) => `appearance:${candidate.id}` === id);
      if (option) void run({ colorScheme: option.id });
      return;
    }
    if (id.startsWith("viewport:")) {
      const option = VIEWPORTS.find((candidate) => `viewport:${candidate.id}` === id);
      if (!option) return;
      void resize({ environmentId, input: { ...target, viewport: option.setting } }).then(
        (result) => {
          if (result._tag === "Failure") Dialog.alert(m(msg("Could not change the viewport")));
        },
      );
    }
  };

  return (
    <Menu
      // Remount when streaming changes, so an open menu never keeps offering
      // the other state's actions.
      key={streaming ? "streaming" : "idle"}
      accessible
      accessibilityLabel={gt("Browser tab options")}
      accessibilityRole="button"
      actions={streaming ? actions : [closeAction]}
      onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
    >
      <ControlPill icon="ellipsis" accessibilityLabel={gt("Browser tab options")} />
    </Menu>
  );
}
