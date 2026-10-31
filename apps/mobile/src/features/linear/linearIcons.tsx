import {
  formatProgressPercent,
  linearBadgeTextTone,
} from "@t3tools/client-runtime/linear/issue-list";
import type { LinearPriority, LinearStateType } from "@t3tools/contracts";
import { Image } from "expo-image";
import { View } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";

import { AppText as Text } from "../../components/ui/AppText";
import { useUniwindTheme } from "../../lib/useUniwindTheme";

const LINEAR_LOGO_PATH =
  "M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.857L39.3342 97.1782c.6889.6889.0915 1.8189-.857 1.5964C20.0515 94.4522 5.54779 79.9485 1.22541 61.5228ZM.00189135 46.8891c-.01764375.2833.08887215.5599.28957165.7606L52.3503 99.7085c.2007.2007.4773.3075.7606.2896 2.3692-.1476 4.6938-.46 6.9624-.9259.7645-.157 1.0301-1.0963.4782-1.6481L2.57595 39.4485c-.55186-.5519-1.49117-.2863-1.648174.4782-.465915 2.2686-.77832 4.5932-.92588465 6.9624ZM4.21093 29.7054c-.16649.3738-.08169.8106.20765 1.1l64.77602 64.776c.2894.2894.7262.3742 1.1.2077 1.7861-.7956 3.5171-1.6927 5.1855-2.684.5521-.328.6373-1.0867.1832-1.5407L8.43566 24.3367c-.45409-.4541-1.21271-.3689-1.54074.1832-.99132 1.6684-1.88843 3.3994-2.68399 5.1855ZM12.6587 18.074c-.3701-.3701-.393-.9637-.0443-1.3541C21.7795 6.45931 35.1114 0 49.9519 0 77.5927 0 100 22.4073 100 50.0481c0 14.8405-6.4593 28.1724-16.7199 37.3375-.3903.3487-.984.3258-1.3542-.0443L12.6587 18.074Z";

const HEX_COLOR = /^#[0-9a-f]{3,8}$/iu;
const SUCCESS = "#22a06b";

export function LinearGlyph(props: { readonly size?: number; readonly color?: string }) {
  const theme = useUniwindTheme();
  const size = props.size ?? 16;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" accessibilityElementsHidden>
      <Path d={LINEAR_LOGO_PATH} fill={props.color ?? theme["--color-foreground"]} />
    </Svg>
  );
}

/** Linear's workflow-state glyph: dashed (backlog), ring, half-filled, check, cross. */
export function LinearStateIcon(props: {
  readonly type: LinearStateType;
  readonly color?: string | undefined;
  readonly size?: number;
}) {
  const theme = useUniwindTheme();
  const fallback: Record<LinearStateType, string> = {
    triage: theme["--color-warning-foreground"],
    backlog: theme["--color-foreground-muted"],
    unstarted: theme["--color-foreground"],
    started: theme["--color-warning-foreground"],
    completed: theme["--color-primary"],
    canceled: theme["--color-foreground-muted"],
  };
  const tint =
    props.color !== undefined && HEX_COLOR.test(props.color) ? props.color : fallback[props.type];
  const size = props.size ?? 14;
  const common = { width: size, height: size, viewBox: "0 0 14 14" } as const;
  switch (props.type) {
    case "backlog":
      return (
        <Svg {...common}>
          <Circle
            cx="7"
            cy="7"
            r="6"
            fill="none"
            stroke={tint}
            strokeWidth="1.6"
            strokeDasharray="2.2 1.9"
          />
        </Svg>
      );
    case "triage":
    case "unstarted":
      return (
        <Svg {...common}>
          <Circle cx="7" cy="7" r="6" fill="none" stroke={tint} strokeWidth="1.6" />
        </Svg>
      );
    case "started":
      return (
        <Svg {...common}>
          <Circle cx="7" cy="7" r="6" fill="none" stroke={tint} strokeWidth="1.6" />
          <Path d="M7 7 L7 3.6 A3.4 3.4 0 1 1 3.6 7 Z" fill={tint} />
        </Svg>
      );
    case "completed":
      return (
        <Svg {...common}>
          <Circle cx="7" cy="7" r="7" fill={tint} />
          <Path
            d="M4.2 7.2 6.1 9 9.8 5.2"
            fill="none"
            stroke="#ffffff"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      );
    case "canceled":
      return (
        <Svg {...common}>
          <Circle cx="7" cy="7" r="7" fill={tint} />
          <Path
            d="M4.8 4.8 9.2 9.2M9.2 4.8 4.8 9.2"
            stroke="#ffffff"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </Svg>
      );
  }
}

const PRIORITY_BARS_ON: Record<2 | 3 | 4, number> = { 2: 3, 3: 2, 4: 1 };
const PRIORITY_BARS = [
  [1.5, 8, 5],
  [5.5, 5, 8],
  [9.5, 2, 11],
] as const;

export function LinearPriorityIcon(props: {
  readonly priority: LinearPriority;
  readonly size?: number;
}) {
  const theme = useUniwindTheme();
  const muted = theme["--color-foreground-muted"];
  const size = props.size ?? 14;
  const common = { width: size, height: size, viewBox: "0 0 14 14" } as const;
  if (props.priority === 1) {
    return (
      <Svg {...common}>
        <Rect
          x="1"
          y="1"
          width="12"
          height="12"
          rx="3"
          fill={theme["--color-warning-foreground"]}
        />
        <Path d="M7 4v3.6" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" />
        <Circle cx="7" cy="10" r="1" fill="#ffffff" />
      </Svg>
    );
  }
  if (props.priority === 0) {
    return (
      <Svg {...common}>
        <Rect x="1.5" y="6.25" width="3" height="1.5" rx=".5" fill={muted} />
        <Rect x="5.5" y="6.25" width="3" height="1.5" rx=".5" fill={muted} />
        <Rect x="9.5" y="6.25" width="3" height="1.5" rx=".5" fill={muted} />
      </Svg>
    );
  }
  const on = PRIORITY_BARS_ON[props.priority];
  return (
    <Svg {...common}>
      {PRIORITY_BARS.map(([x, y, height], index) => (
        <Rect
          key={x}
          x={x}
          y={y}
          width="3"
          height={height}
          rx="1"
          fill={muted}
          opacity={index < on ? 1 : 0.3}
        />
      ))}
    </Svg>
  );
}

/** Diamond used for milestones; fills as progress grows. */
export function LinearMilestoneIcon(props: { readonly progress: number; readonly size?: number }) {
  const theme = useUniwindTheme();
  const done = props.progress >= 1;
  const color = done ? SUCCESS : theme["--color-primary"];
  const size = props.size ?? 14;
  return (
    <Svg width={size} height={size} viewBox="0 0 12 12">
      <Rect
        x="2.2"
        y="2.2"
        width="7.6"
        height="7.6"
        rx="1.5"
        transform="rotate(45 6 6)"
        fill={props.progress > 0 ? color : "none"}
        fillOpacity={done ? 1 : 0.25}
        stroke={color}
        strokeWidth="1.3"
      />
    </Svg>
  );
}

function hashHue(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

export function LinearAvatar(props: {
  readonly user: { readonly name: string; readonly avatarUrl: string | null } | null;
  readonly size?: number;
}) {
  const size = props.size ?? 18;
  const frame = { width: size, height: size, borderRadius: size / 2 } as const;
  if (props.user === null) {
    return (
      <View
        accessibilityLabel="Unassigned"
        className="border border-dashed border-foreground-muted"
        style={frame}
      />
    );
  }
  if (props.user.avatarUrl !== null) {
    return (
      <Image
        accessibilityLabel={props.user.name}
        source={{ uri: props.user.avatarUrl }}
        recyclingKey={props.user.avatarUrl}
        style={frame}
        cachePolicy="memory-disk"
      />
    );
  }
  return (
    <View
      accessibilityLabel={props.user.name}
      className="items-center justify-center"
      style={{ ...frame, backgroundColor: `hsl(${hashHue(props.user.name)}, 55%, 45%)` }}
    >
      <Text
        allowFontScaling={false}
        className="font-t3-bold text-white"
        style={{ fontSize: Math.round(size * 0.45) }}
      >
        {initials(props.user.name)}
      </Text>
    </View>
  );
}

/** Team key chip ("ATT"); tinted by the team's own color when Linear provides one. */
export function LinearTeamBadge(props: {
  readonly teamKey: string;
  readonly color?: string | null;
}) {
  const background =
    props.color !== undefined && props.color !== null && HEX_COLOR.test(props.color)
      ? props.color
      : undefined;
  const dark = background !== undefined && linearBadgeTextTone(background) === "dark";
  return (
    <View
      className={
        background === undefined ? "rounded bg-primary px-1.5 py-0.5" : "rounded px-1.5 py-0.5"
      }
      style={background === undefined ? undefined : { backgroundColor: background }}
    >
      <Text
        allowFontScaling={false}
        className={
          background === undefined
            ? "font-mono text-2xs font-t3-bold text-primary-foreground"
            : dark
              ? "font-mono text-2xs font-t3-bold text-black"
              : "font-mono text-2xs font-t3-bold text-white"
        }
      >
        {props.teamKey}
      </Text>
    </View>
  );
}

export function LinearProgressBar(props: { readonly progress: number; readonly width?: number }) {
  const done = props.progress >= 1;
  return (
    <View
      accessibilityElementsHidden
      className="h-[5px] overflow-hidden rounded-full bg-subtle-strong"
      style={{ width: props.width ?? 72 }}
    >
      <View
        className={done ? "h-full rounded-full" : "h-full rounded-full bg-primary"}
        style={{
          width: `${formatProgressPercent(props.progress)}%`,
          ...(done ? { backgroundColor: SUCCESS } : {}),
        }}
      />
    </View>
  );
}
