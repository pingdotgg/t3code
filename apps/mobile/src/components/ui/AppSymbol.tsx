import IconGitBranch from "@tabler/icons-react-native/IconGitBranch";
import IconGitMerge from "@tabler/icons-react-native/IconGitMerge";
import IconGitCommit from "@tabler/icons-react-native/IconGitCommit";
import IconGitPullRequestClosed from "@tabler/icons-react-native/IconGitPullRequestClosed";
import IconGitPullRequestDraft from "@tabler/icons-react-native/IconGitPullRequestDraft";
import type { SFSymbol } from "expo-symbols";
import IconCircleDot from "@tabler/icons-react-native/IconCircleDot";
import IconGitPullRequest from "@tabler/icons-react-native/IconGitPullRequest";
import IconHammer from "@tabler/icons-react-native/IconHammer";
import IconHome from "@tabler/icons-react-native/IconHome";
import IconInfoCircle from "@tabler/icons-react-native/IconInfoCircle";
import IconKeyboard from "@tabler/icons-react-native/IconKeyboard";
import IconKeyboardHide from "@tabler/icons-react-native/IconKeyboardHide";
import IconLock from "@tabler/icons-react-native/IconLock";
import IconLayoutColumns from "@tabler/icons-react-native/IconLayoutColumns";
import IconLayoutSidebar from "@tabler/icons-react-native/IconLayoutSidebar";
import IconLayoutSidebarRight from "@tabler/icons-react-native/IconLayoutSidebarRight";
import IconLetterSpacing from "@tabler/icons-react-native/IconLetterSpacing";
import IconMicrophone from "@tabler/icons-react-native/IconMicrophone";
import IconMicrophoneOff from "@tabler/icons-react-native/IconMicrophoneOff";
import IconLink from "@tabler/icons-react-native/IconLink";
import IconListNumbers from "@tabler/icons-react-native/IconListNumbers";
import IconMenu2 from "@tabler/icons-react-native/IconMenu2";
import IconMessageCircleQuestion from "@tabler/icons-react-native/IconMessageCircleQuestion";
import IconMessage from "@tabler/icons-react-native/IconMessage";
import IconMessagePlus from "@tabler/icons-react-native/IconMessagePlus";
import IconMinus from "@tabler/icons-react-native/IconMinus";
import IconMoon from "@tabler/icons-react-native/IconMoon";
import IconNetwork from "@tabler/icons-react-native/IconNetwork";
import IconPalette from "@tabler/icons-react-native/IconPalette";
import IconPencil from "@tabler/icons-react-native/IconPencil";
import IconPlug from "@tabler/icons-react-native/IconPlug";
import IconPhoto from "@tabler/icons-react-native/IconPhoto";
import IconPin from "@tabler/icons-react-native/IconPin";
import IconPinnedOff from "@tabler/icons-react-native/IconPinnedOff";
import IconPlayerPause from "@tabler/icons-react-native/IconPlayerPause";
import IconPlayerPlay from "@tabler/icons-react-native/IconPlayerPlay";
import IconPlayerStopFilled from "@tabler/icons-react-native/IconPlayerStopFilled";
import IconPlus from "@tabler/icons-react-native/IconPlus";
import IconQrcode from "@tabler/icons-react-native/IconQrcode";
import IconRefresh from "@tabler/icons-react-native/IconRefresh";
import IconSearch from "@tabler/icons-react-native/IconSearch";
import IconShare from "@tabler/icons-react-native/IconShare";
import IconServer from "@tabler/icons-react-native/IconServer";
import IconSettings from "@tabler/icons-react-native/IconSettings";
import IconSparkles from "@tabler/icons-react-native/IconSparkles";
import IconStack2 from "@tabler/icons-react-native/IconStack2";
import IconStar from "@tabler/icons-react-native/IconStar";
import IconStarFilled from "@tabler/icons-react-native/IconStarFilled";
import IconStethoscope from "@tabler/icons-react-native/IconStethoscope";
import IconSun from "@tabler/icons-react-native/IconSun";
import IconShieldQuestion from "@tabler/icons-react-native/IconShieldQuestion";
import IconTarget from "@tabler/icons-react-native/IconTarget";
import IconTerminal2 from "@tabler/icons-react-native/IconTerminal2";
import IconTextDecrease from "@tabler/icons-react-native/IconTextDecrease";
import IconTextIncrease from "@tabler/icons-react-native/IconTextIncrease";
import IconTool from "@tabler/icons-react-native/IconTool";
import IconTrash from "@tabler/icons-react-native/IconTrash";
import IconTypography from "@tabler/icons-react-native/IconTypography";
import IconUpload from "@tabler/icons-react-native/IconUpload";
import IconUserCircle from "@tabler/icons-react-native/IconUserCircle";
import IconUserCheck from "@tabler/icons-react-native/IconUserCheck";
import IconUserX from "@tabler/icons-react-native/IconUserX";
import IconUserQuestion from "@tabler/icons-react-native/IconUserQuestion";
import IconUserPlus from "@tabler/icons-react-native/IconUserPlus";
import IconUsers from "@tabler/icons-react-native/IconUsers";
import IconWifi from "@tabler/icons-react-native/IconWifi";
import IconWaveSine from "@tabler/icons-react-native/IconWaveSine";
import IconWifiOff from "@tabler/icons-react-native/IconWifiOff";
import IconWorld from "@tabler/icons-react-native/IconWorld";
import IconX from "@tabler/icons-react-native/IconX";
import type { AndroidSymbol, SFSymbol, SymbolViewProps } from "expo-symbols";
import { withUniwind } from "uniwind";
import type { AppSymbolViewProps } from "./AppSymbol.android";

export type { SFSymbol } from "expo-symbols";
export type { AppSymbolName, AppSymbolViewProps } from "./AppSymbol.android";

const CUSTOM_ICONS = {
  "file.diff": IconFileDiff,
  "arrow.triangle.pull": IconGitPullRequest,
  "arrow.triangle.merge": IconGitMerge,
  "arrow.triangle.branch": IconGitBranch,
  "arrow.branch": IconGitBranch,
  "git.pull-request.closed": IconGitPullRequestClosed,
  "git.pull-request.draft": IconGitPullRequestDraft,
  "git.commit": IconGitCommit,
  "arrow.branch": IconGitBranch,
  "arrow.left": IconArrowLeft,
  "arrow.right": IconArrowRight,
  "arrow.left.arrow.right": IconArrowsLeftRight,
  "arrow.clockwise": IconRefresh,
  "arrow.down": IconArrowDown,
  "arrow.down.circle": IconArrowDownCircle,
  "arrow.right.circle": IconArrowRightCircle,
  "arrow.triangle.branch": IconGitBranch,
  "arrow.triangle.merge": IconGitMerge,
  "arrow.triangle.pull": IconGitPullRequest,
  "square.3.layers.3d": IconStack2,
  "arrow.turn.left.up": IconArrowBackUp,
  "arrow.up": IconArrowUp,
  "arrow.up.circle": IconArrowUpCircle,
  "arrow.up.left.and.arrow.down.right": IconArrowsDiagonal2,
  "arrow.down.right.and.arrow.up.left": IconArrowsMinimize,
  "arrow.up.right": IconArrowUpRight,
  "arrow.up.right.circle": IconArrowUpRightCircle,
  "arrow.uturn.backward": IconArrowBackUp,
  "arrow.uturn.forward": IconArrowForwardUp,
  archivebox: IconArchive,
  "archivebox.fill": IconArchive,
  "bell.badge": IconBellRinging,
  "bolt.circle": IconBolt,
  "bolt.horizontal.circle": IconBolt,
  brain: IconBrain,
  "cable.connector": IconPlug,
  camera: IconCamera,
  car: IconCar,
  "chart.bar.xaxis": IconChartBar,
  checkmark: IconCheck,
  "checkmark.circle": IconCircleCheck,
  "checkmark.circle.fill": IconCircleCheck,
  circle: IconCircle,
  "circle.fill": IconCircleFilled,
  "circle.dashed": IconCircleDashed,
  "circle.inset.filled": IconCircleDot,
  "circle.dashed.inset.filled": IconCircleDot,
  "calendar.badge.clock": IconCalendarClock,
  clock: IconClock,
  timer: IconClock,
  "face.smiling": IconMoodPlus,
  tag: IconTag,
  ticket: IconTicket,
  cloud: IconCloud,
  cube: IconBox,
  "chevron.down": IconChevronDown,
  "chevron.left": IconChevronLeft,
  "chevron.left.forwardslash.chevron.right": IconCode,
  "chevron.right": IconChevronRight,
  "chevron.up": IconChevronUp,
  desktopcomputer: IconDeviceDesktop,
  doc: IconFileText,
  "doc.on.doc": IconCopy,
  "doc.text": IconFileText,
  "file.diff": IconFileDiff,
  ellipsis: IconDots,
  moon: IconMoon,
  "ellipsis.circle": IconDotsCircleHorizontal,
  "exclamationmark.triangle": IconAlertTriangle,
  "exclamationmark.circle": IconAlertCircle,
  eye: IconEye,
  "eye.slash": IconEyeOff,
  folder: IconFolder,
  "folder.badge.plus": IconFolderPlus,
  "folder.fill": IconFolder,
  gearshape: IconSettings,
  globe: IconWorld,
  hammer: IconHammer,
  headphones: IconHeadphones,
  house: IconHome,
  "info.circle": IconInfoCircle,
  internaldrive: IconDatabase,
  iphone: IconDeviceMobile,
  keyboard: IconKeyboard,
  laptopcomputer: IconDeviceLaptop,
  link: IconLink,
  "list.number": IconListNumbers,
  "line.3.horizontal": IconMenu2,
  "line.3.horizontal.decrease": IconFilter,
  "line.3.horizontal.decrease.circle": IconFilter,
  "line.3.horizontal.decrease.circle.fill": IconFilterFilled,
  macmini: IconServer,
  macstudio: IconDeviceDesktop,
  magnifyingglass: IconSearch,
  mic: IconMicrophone,
  "mic.slash": IconMicrophoneOff,
  paintbrush: IconPalette,
  pencil: IconPencil,
  "person.crop.circle": IconUserCircle,
  "person.2": IconUsers,
  "person.fill.checkmark": IconUserCheck,
  "person.fill.xmark": IconUserX,
  "person.badge.clock": IconUserQuestion,
  "person.badge.plus": IconUserPlus,
  photo: IconPhoto,
  pin: IconPin,
  "pin.slash": IconPinnedOff,
  play: IconPlayerPlay,
  pause: IconPlayerPause,
  plus: IconPlus,
  minus: IconMinus,
  "slash.circle": IconBan,
  "qrcode.viewfinder": IconQrcode,
  "point.3.connected.trianglepath.dotted": IconNetwork,
  "point.topleft.down.curvedto.point.bottomright.up": IconGitMerge,
  safari: IconExternalLink,
  "server.rack": IconServer,
  stethoscope: IconStethoscope,
  "sidebar.left": IconLayoutSidebar,
  "sidebar.right": IconLayoutSidebarRight,
  "slider.horizontal.3": IconAdjustmentsHorizontal,
  "square.and.arrow.up": IconShare,
  "square.and.pencil": IconEdit,
  "square.on.square": IconCopy,
  "square.grid.2x2": IconApps,
  "square.split.2x1": IconLayoutColumns,
  star: IconStar,
  "star.fill": IconStarFilled,
  "sun.max": IconSun,
  "stop.fill": IconPlayerStopFilled,
  target: IconTarget,
  terminal: IconTerminal2,
  "text.alignleft": IconAlignLeft,
  "text.bubble": IconMessage,
  "questionmark.bubble": IconMessageCircleQuestion,
  "exclamationmark.shield": IconShieldQuestion,
  "bubble.left.and.bubble.right": IconMessage,
  "bubble.left": IconMessage,
  sparkles: IconSparkles,
  "plus.bubble": IconMessagePlus,
  "text.word.spacing": IconLetterSpacing,
  "textformat.size": IconTypography,
  "textformat.size.larger": IconTextIncrease,
  "textformat.size.smaller": IconTextDecrease,
  "tray.and.arrow.up": IconUpload,
  trash: IconTrash,
  wifi: IconWifi,
  waveform: IconWaveSine,
  "wifi.slash": IconWifiOff,
  xmark: IconX,
  "xmark.circle.fill": IconCircleXFilled,
} satisfies Partial<
  Record<
    SFSymbol | "git.pull-request.closed" | "git.pull-request.draft" | "git.commit" | "file.diff",
    Icon
  >
>;
const SF_ICON_LOOKUP: Partial<
  Record<
    SFSymbol | "git.pull-request.closed" | "git.pull-request.draft" | "git.commit" | "file.diff",
    Icon
  >
> = ANDROID_ICON_BY_SF_SYMBOL;

const ANDROID_ICON_BY_MATERIAL_NAME = {
  auto_awesome: IconSparkles,
  bolt: IconBolt,
  build: IconTool,
  chat: IconMessage,
  chat_bubble: IconMessage,
  check: IconCheck,
  close: IconX,
  construction: IconHammer,
  content_copy: IconCopy,
  desktop_windows: IconDeviceDesktop,
  edit: IconEdit,
  error: IconAlertCircle,
  folder: IconFolder,
  folder_open: IconFolderOpen,
  keyboard: IconKeyboard,
  keyboard_arrow_down: IconChevronDown,
  keyboard_arrow_up: IconChevronUp,
  keyboard_hide: IconKeyboardHide,
  lock: IconLock,
  more_vert: IconDotsVertical,
  merge: IconGitMerge,
  psychology: IconBrain,
  public: IconWorld,
  remove: IconMinus,
  smartphone: IconDeviceMobile,
  terminal: IconTerminal2,
  visibility: IconEye,
} satisfies Partial<Record<AndroidSymbol, Icon>>;

export type { SFSymbol } from "expo-symbols";
export type AppSymbolName =
  | keyof typeof ANDROID_ICON_BY_SF_SYMBOL
  | {
      ios: SFSymbol;
      android: keyof typeof ANDROID_ICON_BY_MATERIAL_NAME;
    };

export type AppSymbolViewProps = Omit<SymbolViewProps, "name"> & { name: AppSymbolName };

export function isAppSymbolName(name: string): name is Extract<AppSymbolName, string> {
  return Object.prototype.hasOwnProperty.call(ANDROID_ICON_BY_SF_SYMBOL, name);
}

function AppSymbolView(props: AppSymbolViewProps) {
  const name = typeof props.name === "string" ? props.name : props.name.ios;
  const CustomIcon = CUSTOM_ICONS[name as keyof typeof CUSTOM_ICONS];
  if (CustomIcon) {
    return (
      <CustomIcon
        accessibilityLabel={props.accessibilityLabel}
        color={props.tintColor}
        size={props.size}
        strokeWidth={2}
        style={props.style}
        testID={props.testID}
      />
    );
  }

  return <ExpoSymbolView {...props} name={name as SFSymbol} />;
}

export const SymbolView = withUniwind(AppSymbolView);
