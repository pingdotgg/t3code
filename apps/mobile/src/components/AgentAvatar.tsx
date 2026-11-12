import type { Icon } from "@tabler/icons-react-native/types";
/* Per-icon imports keep Metro from registering the whole Tabler set. */
import IconActivity from "@tabler/icons-react-native/IconActivity";
import IconAt from "@tabler/icons-react-native/IconAt";
import IconBell from "@tabler/icons-react-native/IconBell";
import IconBolt from "@tabler/icons-react-native/IconBolt";
import IconBook from "@tabler/icons-react-native/IconBook";
import IconBraces from "@tabler/icons-react-native/IconBraces";
import IconBrain from "@tabler/icons-react-native/IconBrain";
import IconBrush from "@tabler/icons-react-native/IconBrush";
import IconBug from "@tabler/icons-react-native/IconBug";
import IconBulb from "@tabler/icons-react-native/IconBulb";
import IconCalendar from "@tabler/icons-react-native/IconCalendar";
import IconCamera from "@tabler/icons-react-native/IconCamera";
import IconChartBar from "@tabler/icons-react-native/IconChartBar";
import IconClipboardList from "@tabler/icons-react-native/IconClipboardList";
import IconCloud from "@tabler/icons-react-native/IconCloud";
import IconCode from "@tabler/icons-react-native/IconCode";
import IconCoffee from "@tabler/icons-react-native/IconCoffee";
import IconCompass from "@tabler/icons-react-native/IconCompass";
import IconCpu from "@tabler/icons-react-native/IconCpu";
import IconDatabase from "@tabler/icons-react-native/IconDatabase";
import IconFileText from "@tabler/icons-react-native/IconFileText";
import IconFlag from "@tabler/icons-react-native/IconFlag";
import IconFlask from "@tabler/icons-react-native/IconFlask";
import IconGauge from "@tabler/icons-react-native/IconGauge";
import IconGitBranch from "@tabler/icons-react-native/IconGitBranch";
import IconGitPullRequest from "@tabler/icons-react-native/IconGitPullRequest";
import IconHash from "@tabler/icons-react-native/IconHash";
import IconHeart from "@tabler/icons-react-native/IconHeart";
import IconLayoutDashboard from "@tabler/icons-react-native/IconLayoutDashboard";
import IconLifebuoy from "@tabler/icons-react-native/IconLifebuoy";
import IconLock from "@tabler/icons-react-native/IconLock";
import IconMail from "@tabler/icons-react-native/IconMail";
import IconMap from "@tabler/icons-react-native/IconMap";
import IconMessageCircle from "@tabler/icons-react-native/IconMessageCircle";
import IconMicroscope from "@tabler/icons-react-native/IconMicroscope";
import IconMovie from "@tabler/icons-react-native/IconMovie";
import IconMusic from "@tabler/icons-react-native/IconMusic";
import IconPackage from "@tabler/icons-react-native/IconPackage";
import IconPalette from "@tabler/icons-react-native/IconPalette";
import IconPencil from "@tabler/icons-react-native/IconPencil";
import IconPhoto from "@tabler/icons-react-native/IconPhoto";
import IconPuzzle from "@tabler/icons-react-native/IconPuzzle";
import IconRobot from "@tabler/icons-react-native/IconRobot";
import IconRocket from "@tabler/icons-react-native/IconRocket";
import IconSchool from "@tabler/icons-react-native/IconSchool";
import IconSearch from "@tabler/icons-react-native/IconSearch";
import IconServer from "@tabler/icons-react-native/IconServer";
import IconSettings from "@tabler/icons-react-native/IconSettings";
import IconShare from "@tabler/icons-react-native/IconShare";
import IconShield from "@tabler/icons-react-native/IconShield";
import IconSparkles from "@tabler/icons-react-native/IconSparkles";
import IconSpeakerphone from "@tabler/icons-react-native/IconSpeakerphone";
import IconStar from "@tabler/icons-react-native/IconStar";
import IconTarget from "@tabler/icons-react-native/IconTarget";
import IconTelescope from "@tabler/icons-react-native/IconTelescope";
import IconTerminal2 from "@tabler/icons-react-native/IconTerminal2";
import IconTestPipe from "@tabler/icons-react-native/IconTestPipe";
import IconTool from "@tabler/icons-react-native/IconTool";
import IconTrendingUp from "@tabler/icons-react-native/IconTrendingUp";
import IconTriangleSquareCircle from "@tabler/icons-react-native/IconTriangleSquareCircle";
import IconUsers from "@tabler/icons-react-native/IconUsers";
import IconVectorBezier from "@tabler/icons-react-native/IconVectorBezier";
import IconWorld from "@tabler/icons-react-native/IconWorld";
import { memo, useId } from "react";
import { View } from "react-native";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";
import { isAgentIconId, type AgentIconId } from "@t3tools/client-runtime/state/agentIdentity";

// Tabler on both platforms, so an agent looks the same as its web/desktop
// (Lucide) glyph instead of the nearest SF Symbol.
const AGENT_GLYPHS = {
  bot: IconRobot,
  sparkles: IconSparkles,
  zap: IconBolt,
  star: IconStar,
  coffee: IconCoffee,
  code: IconCode,
  terminal: IconTerminal2,
  braces: IconBraces,
  "git-branch": IconGitBranch,
  "git-pull-request": IconGitPullRequest,
  bug: IconBug,
  "test-tube": IconTestPipe,
  database: IconDatabase,
  cpu: IconCpu,
  package: IconPackage,
  puzzle: IconPuzzle,
  wrench: IconTool,
  rocket: IconRocket,
  target: IconTarget,
  lightbulb: IconBulb,
  "layout-dashboard": IconLayoutDashboard,
  "clipboard-list": IconClipboardList,
  flag: IconFlag,
  map: IconMap,
  compass: IconCompass,
  "trending-up": IconTrendingUp,
  search: IconSearch,
  "book-open": IconBook,
  "graduation-cap": IconSchool,
  microscope: IconMicroscope,
  flask: IconFlask,
  brain: IconBrain,
  globe: IconWorld,
  "chart-column": IconChartBar,
  "file-text": IconFileText,
  telescope: IconTelescope,
  "message-circle": IconMessageCircle,
  megaphone: IconSpeakerphone,
  users: IconUsers,
  heart: IconHeart,
  mail: IconMail,
  "at-sign": IconAt,
  share: IconShare,
  hash: IconHash,
  shield: IconShield,
  lock: IconLock,
  server: IconServer,
  cloud: IconCloud,
  activity: IconActivity,
  gauge: IconGauge,
  calendar: IconCalendar,
  bell: IconBell,
  settings: IconSettings,
  "life-buoy": IconLifebuoy,
  pen: IconPencil,
  palette: IconPalette,
  brush: IconBrush,
  "pen-tool": IconVectorBezier,
  camera: IconCamera,
  image: IconPhoto,
  film: IconMovie,
  music: IconMusic,
  shapes: IconTriangleSquareCircle,
} satisfies Record<Exclude<AgentIconId, "orb">, Icon>;

/** Deleted agents have no color; a neutral gray reads on light and dark. */
const FALLBACK_COLOR = "#8e8e93";

function channels(hex: string) {
  const value = Number.parseInt(hex.slice(1, 7), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff] as const;
}

/** Dark glyphs on the pastel palette, white on saturated or dark picks. */
function glyphColorOn(hex: string) {
  const linear = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = channels(hex);
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return luminance > 0.36 ? "#1c1c1e" : "#ffffff";
}

/** Web's orb shadow stop: `color-mix(in srgb, color 45%, #111)`. */
function orbShade(hex: string) {
  const mixed = channels(hex).map((c) => Math.round(c * 0.45 + 0x11 * 0.55));
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** The lit sphere web draws for `orb`: white highlight up-left, shading to a darker rim. */
function AgentOrb(props: { readonly color: string; readonly size: number }) {
  const id = useId();
  return (
    <Svg width={props.size} height={props.size} viewBox="0 0 100 100">
      <Defs>
        <RadialGradient id={id} cx="32%" cy="28%" fx="32%" fy="28%" r="99%">
          <Stop offset="0%" stopColor="#ffffff" />
          <Stop offset="35%" stopColor={props.color} />
          <Stop offset="85%" stopColor={orbShade(props.color)} />
          <Stop offset="100%" stopColor={orbShade(props.color)} />
        </RadialGradient>
      </Defs>
      <Circle cx="50" cy="50" r="50" fill={`url(#${id})`} />
    </Svg>
  );
}

/**
 * An agent's icon on a solid disc of its color. `icon` is a catalog id or a
 * legacy literal; `iconId` wins when this build knows it. Unknown icons and
 * "orb" draw the lit sphere web draws.
 */
export const AgentAvatar = memo(function AgentAvatar(props: {
  readonly icon: string | null | undefined;
  readonly iconId?: string | null | undefined;
  readonly color: string | null;
  readonly size?: number;
}) {
  const size = props.size ?? 28;
  const color = props.color ?? FALLBACK_COLOR;
  const key = isAgentIconId(props.iconId)
    ? props.iconId
    : isAgentIconId(props.icon)
      ? props.icon
      : "orb";
  const Glyph = key === "orb" ? null : AGENT_GLYPHS[key];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: Glyph ? color : undefined,
        overflow: "hidden",
      }}
    >
      {Glyph ? (
        <Glyph color={glyphColorOn(color)} size={Math.round(size * 0.56)} strokeWidth={2} />
      ) : (
        <AgentOrb color={color} size={size} />
      )}
    </View>
  );
});
