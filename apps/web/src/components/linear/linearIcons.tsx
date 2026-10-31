import type { LinearPriority, LinearStateType } from "@t3tools/contracts";
import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";

import { linearBadgeTextTone } from "@t3tools/client-runtime/linear/issue-list";

const LINEAR_LOGO_PATH =
  "M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.857L39.3342 97.1782c.6889.6889.0915 1.8189-.857 1.5964C20.0515 94.4522 5.54779 79.9485 1.22541 61.5228ZM.00189135 46.8891c-.01764375.2833.08887215.5599.28957165.7606L52.3503 99.7085c.2007.2007.4773.3075.7606.2896 2.3692-.1476 4.6938-.46 6.9624-.9259.7645-.157 1.0301-1.0963.4782-1.6481L2.57595 39.4485c-.55186-.5519-1.49117-.2863-1.648174.4782-.465915 2.2686-.77832 4.5932-.92588465 6.9624ZM4.21093 29.7054c-.16649.3738-.08169.8106.20765 1.1l64.77602 64.776c.2894.2894.7262.3742 1.1.2077 1.7861-.7956 3.5171-1.6927 5.1855-2.684.5521-.328.6373-1.0867.1832-1.5407L8.43566 24.3367c-.45409-.4541-1.21271-.3689-1.54074.1832-.99132 1.6684-1.88843 3.3994-2.68399 5.1855ZM12.6587 18.074c-.3701-.3701-.393-.9637-.0443-1.3541C21.7795 6.45931 35.1114 0 49.9519 0 77.5927 0 100 22.4073 100 50.0481c0 14.8405-6.4593 28.1724-16.7199 37.3375-.3903.3487-.984.3258-1.3542-.0443L12.6587 18.074Z";

export function LinearGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 100 100"
      fill="currentColor"
      className={cn("size-4 shrink-0", className)}
    >
      <path d={LINEAR_LOGO_PATH} />
    </svg>
  );
}

const STATE_TYPE_COLOR: Record<LinearStateType, string> = {
  triage: "var(--warning)",
  backlog: "var(--muted-foreground)",
  unstarted: "var(--foreground)",
  started: "var(--warning)",
  completed: "var(--primary)",
  canceled: "var(--muted-foreground)",
};

const HEX_COLOR = /^#[0-9a-f]{3,8}$/iu;

function linearStateColor(type: LinearStateType, color?: string | undefined): string {
  return color !== undefined && HEX_COLOR.test(color) ? color : STATE_TYPE_COLOR[type];
}

/** Linear's workflow-state glyph: dashed (backlog), ring, half-filled, check, cross. */
export function LinearStateIcon({
  type,
  color,
  className,
}: {
  type: LinearStateType;
  color?: string | undefined;
  className?: string;
}) {
  const tint = linearStateColor(type, color);
  const common = {
    viewBox: "0 0 14 14",
    "aria-hidden": true,
    className: cn("size-3.5 shrink-0", className),
  };
  switch (type) {
    case "backlog":
      return (
        <svg {...common}>
          <circle
            cx="7"
            cy="7"
            r="6"
            fill="none"
            stroke={tint}
            strokeWidth="1.6"
            strokeDasharray="2.2 1.9"
          />
        </svg>
      );
    case "triage":
    case "unstarted":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="6" fill="none" stroke={tint} strokeWidth="1.6" />
        </svg>
      );
    case "started":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="6" fill="none" stroke={tint} strokeWidth="1.6" />
          <path d="M7 7 L7 3.6 A3.4 3.4 0 1 1 3.6 7 Z" fill={tint} />
        </svg>
      );
    case "completed":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="7" fill={tint} />
          <path
            d="M4.2 7.2 6.1 9 9.8 5.2"
            fill="none"
            stroke="var(--color-white)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "canceled":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="7" fill={tint} />
          <path
            d="M4.8 4.8 9.2 9.2M9.2 4.8 4.8 9.2"
            stroke="var(--color-white)"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}

const PRIORITY_BARS_ON: Record<2 | 3 | 4, number> = { 2: 3, 3: 2, 4: 1 };
const PRIORITY_BARS = [
  [1.5, 8, 5],
  [5.5, 5, 8],
  [9.5, 2, 11],
] as const;

export function LinearPriorityIcon({
  priority,
  className,
}: {
  priority: LinearPriority;
  className?: string;
}) {
  const common = {
    viewBox: "0 0 14 14",
    "aria-hidden": true,
    className: cn("size-3.5 shrink-0", className),
  };
  if (priority === 1) {
    return (
      <svg {...common}>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="var(--warning)" />
        <path d="M7 4v3.6" stroke="var(--color-white)" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="7" cy="10" r="1" fill="var(--color-white)" />
      </svg>
    );
  }
  if (priority === 0) {
    return (
      <svg {...common} fill="var(--muted-foreground)">
        <rect x="1.5" y="6.25" width="3" height="1.5" rx=".5" />
        <rect x="5.5" y="6.25" width="3" height="1.5" rx=".5" />
        <rect x="9.5" y="6.25" width="3" height="1.5" rx=".5" />
      </svg>
    );
  }
  const on = PRIORITY_BARS_ON[priority];
  return (
    <svg {...common}>
      {PRIORITY_BARS.map(([x, y, height], index) => (
        <rect
          key={x}
          x={x}
          y={y}
          width="3"
          height={height}
          rx="1"
          fill="var(--muted-foreground)"
          opacity={index < on ? 1 : 0.3}
        />
      ))}
    </svg>
  );
}

/** Diamond used for milestones; fills as progress grows. */
export function LinearMilestoneIcon({
  progress,
  className,
}: {
  progress: number;
  className?: string;
}) {
  const done = progress >= 1;
  const color = done ? "var(--success)" : "var(--primary)";
  return (
    <svg viewBox="0 0 12 12" aria-hidden className={cn("size-3 shrink-0", className)}>
      <rect
        x="2.2"
        y="2.2"
        width="7.6"
        height="7.6"
        rx="1.5"
        transform="rotate(45 6 6)"
        fill={progress > 0 ? color : "none"}
        fillOpacity={done ? 1 : 0.25}
        stroke={color}
        strokeWidth="1.3"
      />
    </svg>
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

export function LinearAvatar({
  user,
  className,
}: {
  user: { readonly name: string; readonly avatarUrl: string | null } | null;
  className?: string;
}) {
  const size = cn("size-[18px] shrink-0 rounded-full", className);
  if (user === null) {
    return (
      <span
        aria-label="Unassigned"
        className={cn(size, "inline-flex border border-dashed border-muted-foreground/60")}
      />
    );
  }
  if (user.avatarUrl !== null) {
    return <img src={user.avatarUrl} alt="" className={cn(size, "object-cover")} />;
  }
  const style: CSSProperties = { backgroundColor: `hsl(${hashHue(user.name)} 55% 45%)` };
  return (
    <span
      aria-hidden
      style={style}
      className={cn(
        size,
        "inline-flex items-center justify-center text-3xs font-semibold tracking-tight text-white",
      )}
    >
      {initials(user.name)}
    </span>
  );
}

/** Team key chip ("ATT"); tinted by the team's own color when Linear provides one. */
export function LinearTeamBadge({
  teamKey,
  color,
  className,
}: {
  teamKey: string;
  color?: string | null;
  className?: string;
}) {
  const background =
    color !== undefined && color !== null && HEX_COLOR.test(color) ? color : undefined;
  return (
    <span
      style={background === undefined ? undefined : { backgroundColor: background }}
      className={cn(
        "inline-flex h-[15px] shrink-0 items-center rounded px-1 font-mono text-3xs leading-none font-semibold",
        background === undefined
          ? "bg-primary text-primary-foreground"
          : linearBadgeTextTone(background) === "dark"
            ? "text-black"
            : "text-white",
        className,
      )}
    >
      {teamKey}
    </span>
  );
}
