import {
  IconAdjustmentsHorizontal,
  IconAlertCircle,
  IconAlertTriangle,
  IconArchive,
  IconArrowBackUp,
  IconArrowDownCircle,
  IconArrowRightCircle,
  IconArrowUp,
  IconArrowUpCircle,
  IconArrowUpRight,
  IconArrowUpRightCircle,
  IconBellRinging,
  IconBolt,
  IconCamera,
  IconCheck,
  IconChevronDown,
  IconCode,
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
  IconFolderOpen,
  IconFolderPlus,
  IconGitBranch,
  IconHammer,
  IconGitMerge,
  IconInfoCircle,
  IconKeyboard,
  IconKeyboardHide,
  IconLayoutColumns,
  IconLayoutSidebar,
  IconLetterSpacing,
  IconLink,
  IconMessage,
  IconMinus,
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
  IconSparkles,
  IconLayoutSidebarRight,
  IconTerminal2,
  IconTextDecrease,
  IconTextIncrease,
  IconTool,
  IconTrash,
  IconTypography,
  IconUserCircle,
  IconWifiOff,
  IconWorld,
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
  "arrow.up.circle": IconArrowUpCircle,
  "arrow.up.right": IconArrowUpRight,
  "arrow.up.right.circle": IconArrowUpRightCircle,
  "arrow.uturn.backward": IconArrowBackUp,
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
  "chevron.left.forwardslash.chevron.right": IconCode,
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
  "sidebar.left": IconLayoutSidebar,
  "sidebar.right": IconLayoutSidebarRight,
  "slider.horizontal.3": IconAdjustmentsHorizontal,
  "square.and.pencil": IconEdit,
  "square.split.2x1": IconLayoutColumns,
  "stop.fill": IconPlayerStopFilled,
  terminal: IconTerminal2,
  "text.bubble": IconMessage,
  "text.word.spacing": IconLetterSpacing,
  "textformat.size": IconTypography,
  "textformat.size.larger": IconTextIncrease,
  "textformat.size.smaller": IconTextDecrease,
  trash: IconTrash,
  "wifi.slash": IconWifiOff,
  xmark: IconX,
  "xmark.circle.fill": IconCircleXFilled,
};

// Callers can pass `{ ios, android }` names where `android` is a Material
// icon name (the raw expo-symbols contract). Resolve those here too so the
// android key keeps working through this wrapper — it wins over the SF map
// when both match (e.g. folder vs folder_open for expanded project groups).
const ANDROID_ICON_BY_MATERIAL_NAME: Record<string, Icon> = {
  auto_awesome: IconSparkles,
  bolt: IconBolt,
  build: IconTool,
  chat_bubble: IconMessage,
  check: IconCheck,
  close: IconX,
  construction: IconHammer,
  content_copy: IconCopy,
  edit: IconEdit,
  error: IconAlertCircle,
  folder: IconFolder,
  folder_open: IconFolderOpen,
  keyboard: IconKeyboard,
  keyboard_arrow_down: IconChevronDown,
  keyboard_arrow_up: IconChevronUp,
  keyboard_hide: IconKeyboardHide,
  public: IconWorld,
  remove: IconMinus,
  terminal: IconTerminal2,
  visibility: IconEye,
};

export type { SFSymbol } from "expo-symbols";
export type AppSymbolName = SymbolViewProps["name"];

export function SymbolView(props: SymbolViewProps) {
  if (Platform.OS !== "android") {
    return <ExpoSymbolView {...props} />;
  }

  const materialName = typeof props.name === "string" ? undefined : props.name.android;
  const sfSymbol = typeof props.name === "string" ? props.name : props.name.ios;
  const AndroidIcon =
    (materialName ? ANDROID_ICON_BY_MATERIAL_NAME[materialName] : undefined) ??
    (sfSymbol ? ANDROID_ICON_BY_SF_SYMBOL[sfSymbol] : undefined);

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
