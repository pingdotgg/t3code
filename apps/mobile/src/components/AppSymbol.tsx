import {
  IconAdjustmentsHorizontal,
  IconAlertTriangle,
  IconArchive,
  IconArrowBackUp,
  IconArrowDownCircle,
  IconArrowRightCircle,
  IconArrowUp,
  IconArrowUpRight,
  IconBellRinging,
  IconBolt,
  IconCamera,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCircleCheck,
  IconCircleXFilled,
  IconCopy,
  IconDeviceDesktop,
  IconDots,
  IconDotsCircleHorizontal,
  IconEdit,
  IconExternalLink,
  IconEye,
  IconFileText,
  IconFilter,
  IconFolder,
  IconFolderPlus,
  IconGitBranch,
  IconGitMerge,
  IconInfoCircle,
  IconLayoutColumns,
  IconLink,
  IconMessage,
  IconNetwork,
  IconPalette,
  IconPlayerPlay,
  IconPlayerStopFilled,
  IconPlus,
  IconQrcode,
  IconRefresh,
  IconSearch,
  IconServer,
  IconSettings,
  IconLayoutSidebarRight,
  IconTerminal2,
  IconTrash,
  IconTypography,
  IconUserCircle,
  IconWifiOff,
  IconX,
  type Icon,
} from "@tabler/icons-react-native";
import { Platform } from "react-native";
import { SymbolView as ExpoSymbolView, type SFSymbol, type SymbolViewProps } from "expo-symbols";

const ANDROID_ICON_BY_SF_SYMBOL: Partial<Record<SFSymbol, Icon>> = {
  "arrow.branch": IconGitBranch,
  "arrow.clockwise": IconRefresh,
  "arrow.down.circle": IconArrowDownCircle,
  "arrow.right.circle": IconArrowRightCircle,
  "arrow.triangle.branch": IconGitBranch,
  "arrow.turn.left.up": IconArrowBackUp,
  "arrow.up": IconArrowUp,
  "arrow.up.right": IconArrowUpRight,
  archivebox: IconArchive,
  "archivebox.fill": IconArchive,
  "bell.badge": IconBellRinging,
  "bolt.circle": IconBolt,
  "bolt.horizontal.circle": IconBolt,
  camera: IconCamera,
  checkmark: IconCheck,
  "checkmark.circle": IconCircleCheck,
  "chevron.down": IconChevronDown,
  "chevron.left": IconChevronLeft,
  "chevron.right": IconChevronRight,
  "chevron.up": IconChevronUp,
  desktopcomputer: IconDeviceDesktop,
  "doc.on.doc": IconCopy,
  "doc.text": IconFileText,
  ellipsis: IconDots,
  "ellipsis.circle": IconDotsCircleHorizontal,
  "exclamationmark.triangle": IconAlertTriangle,
  eye: IconEye,
  folder: IconFolder,
  "folder.badge.plus": IconFolderPlus,
  "folder.fill": IconFolder,
  gearshape: IconSettings,
  "info.circle": IconInfoCircle,
  link: IconLink,
  "line.3.horizontal.decrease.circle": IconFilter,
  "line.3.horizontal.decrease.circle.fill": IconFilter,
  magnifyingglass: IconSearch,
  paintbrush: IconPalette,
  "person.crop.circle": IconUserCircle,
  play: IconPlayerPlay,
  plus: IconPlus,
  "qrcode.viewfinder": IconQrcode,
  "point.3.connected.trianglepath.dotted": IconNetwork,
  "point.topleft.down.curvedto.point.bottomright.up": IconGitMerge,
  safari: IconExternalLink,
  "server.rack": IconServer,
  "sidebar.right": IconLayoutSidebarRight,
  "slider.horizontal.3": IconAdjustmentsHorizontal,
  "square.and.pencil": IconEdit,
  "square.split.2x1": IconLayoutColumns,
  "stop.fill": IconPlayerStopFilled,
  terminal: IconTerminal2,
  "text.bubble": IconMessage,
  "textformat.size": IconTypography,
  trash: IconTrash,
  "wifi.slash": IconWifiOff,
  xmark: IconX,
  "xmark.circle.fill": IconCircleXFilled,
};

export type { SFSymbol } from "expo-symbols";
export type AppSymbolName = SymbolViewProps["name"];

export function SymbolView(props: SymbolViewProps) {
  if (Platform.OS !== "android") {
    return <ExpoSymbolView {...props} />;
  }

  const sfSymbol = typeof props.name === "string" ? props.name : props.name.ios;
  const AndroidIcon = sfSymbol ? ANDROID_ICON_BY_SF_SYMBOL[sfSymbol] : undefined;

  if (!AndroidIcon) {
    return props.fallback ?? null;
  }

  return (
    <AndroidIcon
      accessibilityLabel={props.accessibilityLabel}
      color={props.tintColor}
      size={props.size}
      strokeWidth={2}
      style={props.style}
      testID={props.testID}
    />
  );
}
