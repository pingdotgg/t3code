import { type CSSProperties, memo } from "react";

import {
  isProviderInstanceInitialsIcon,
  PROVIDER_INSTANCE_LOGO_ICONS,
  providerInstanceInitialsGlyphScale,
  resolveProviderInstanceBadgeLabel,
  resolveProviderInstanceGlyphDriver,
} from "@t3tools/client-runtime/state/provider-instance-display";

import { ProviderDriverKind } from "@t3tools/contracts";
import {
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  GrokIcon,
  Icon,
  OpenAI,
  OpenCodeIcon,
  PiAgentIcon,
} from "../Icons";

import { cn } from "~/lib/utils";
import {
  AcpRegistryAgentIcon,
  officialAcpRegistryIconUrlForAgentId,
  resolveOfficialAcpRegistryIconUrl,
} from "../settings/AcpRegistryIcon";

const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
  [ProviderDriverKind.make("antigravity")]: AntigravityIcon,
  [ProviderDriverKind.make("pi")]: PiAgentIcon,
};

const PROVIDER_TEXT_COLOR_BY_PROVIDER: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "text-black dark:text-white",
  [ProviderDriverKind.make("claudeAgent")]: "text-[#d97757]",
  [ProviderDriverKind.make("cursor")]: "text-[#26251E] dark:text-[#EDECEC]",
  [ProviderDriverKind.make("grok")]: "text-[#0F0F0F] dark:text-[#F5F5F5]",
  [ProviderDriverKind.make("pi")]: "text-[#0F0F0F] dark:text-[#F5F5F5]",
  [ProviderDriverKind.make("opencode")]: "text-[#211E1E] dark:text-[#F1ECEC]",
  [ProviderDriverKind.make("antigravity")]: "text-[#5b87bf]",
};

const PROVIDER_LOGO_LABEL: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "OpenAI",
  [ProviderDriverKind.make("claudeAgent")]: "Claude",
  [ProviderDriverKind.make("opencode")]: "OpenCode",
  [ProviderDriverKind.make("cursor")]: "Cursor",
  [ProviderDriverKind.make("grok")]: "Grok",
  [ProviderDriverKind.make("antigravity")]: "Antigravity",
  [ProviderDriverKind.make("pi")]: "Pi",
};

/** Logos an instance can choose, in the order settings offers them. */
export const PROVIDER_INSTANCE_LOGO_OPTIONS = PROVIDER_INSTANCE_LOGO_ICONS.map((icon) => ({
  icon,
  label: PROVIDER_LOGO_LABEL[icon] ?? icon,
}));

export function providerTextColorClassName(driverKind: ProviderDriverKind): string | undefined {
  return PROVIDER_TEXT_COLOR_BY_PROVIDER[driverKind];
}

export function resolveProviderInstanceAcpRegistryIconUrl(input: {
  readonly driverKind: ProviderDriverKind;
  readonly agentId?: string | undefined;
  readonly iconUrl?: string | undefined;
}): string | null {
  if (input.driverKind !== "acpRegistry") return null;
  return (
    resolveOfficialAcpRegistryIconUrl(input.iconUrl ?? null) ??
    officialAcpRegistryIconUrlForAgentId(input.agentId?.trim() || null)
  );
}

export const ProviderInstanceIcon = memo(function ProviderInstanceIcon(props: {
  driverKind: ProviderDriverKind;
  displayName: string;
  accentColor?: string | undefined;
  /** Chosen glyph: a driver slug with a logo, or the initials icon. */
  icon?: string | undefined;
  badgeLabel?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  showBadge?: boolean;
  badgeContent?: "initials" | "none";
  className?: string;
  iconClassName?: string;
  badgeClassName?: string;
  statusDotClassName?: string;
  indicatorBackground?: string;
}) {
  const glyphDriver = resolveProviderInstanceGlyphDriver(props);
  const Icon = PROVIDER_ICON_BY_PROVIDER[glyphDriver] ?? null;
  const drawsInitials = isProviderInstanceInitialsIcon(props.icon);
  const badgeLabel = resolveProviderInstanceBadgeLabel(props);
  const indicatorBackground = props.indicatorBackground ?? "var(--card)";
  const accentStyle = props.accentColor
    ? ({ "--provider-accent": props.accentColor } as CSSProperties)
    : undefined;
  const badgeContent = props.badgeContent ?? "initials";
  const isAcpRegistry = glyphDriver === "acpRegistry";
  const acpRegistryIconUrl = resolveProviderInstanceAcpRegistryIconUrl({
    driverKind: props.driverKind,
    agentId: props.acpRegistryAgentId,
    iconUrl: props.acpRegistryIconUrl,
  });

  return (
    <span
      className={cn(
        "relative isolate z-30 inline-flex shrink-0 items-center justify-center overflow-visible",
        props.className,
      )}
      style={accentStyle}
      data-provider-accent-color={props.accentColor}
    >
      {drawsInitials ? (
        // Container units scale the label with whatever size the caller gives
        // the glyph, from a 12px thread row to the 20px picker rail.
        <span
          className={cn(
            "@container flex size-5 shrink-0 items-center justify-center",
            props.iconClassName,
            props.accentColor && "text-(--provider-accent)",
          )}
          aria-hidden
        >
          <span
            className="font-bold leading-none whitespace-nowrap"
            style={{ fontSize: `${providerInstanceInitialsGlyphScale(badgeLabel) * 100}cqw` }}
          >
            {badgeLabel}
          </span>
        </span>
      ) : isAcpRegistry ? (
        <AcpRegistryAgentIcon
          // The search-tile radius would crop most of the glyph at these
          // inline sizes.
          className={cn("size-5 rounded-none bg-transparent", props.iconClassName)}
          fallbackClassName="size-full"
          icon={acpRegistryIconUrl}
        />
      ) : Icon ? (
        <Icon className={cn("size-5 shrink-0", props.iconClassName)} aria-hidden />
      ) : (
        <span className={cn("text-3xs font-semibold leading-none", props.iconClassName)}>
          {badgeLabel}
        </span>
      )}
      {props.statusDotClassName ? (
        <span
          className={cn(
            "pointer-events-none absolute -left-0.5 -top-0.5 z-10 size-2 rounded-full",
            props.statusDotClassName,
          )}
          style={{ boxShadow: `0 0 0 2px ${indicatorBackground}` }}
          aria-hidden
        />
      ) : null}
      {props.showBadge ? (
        <span
          className={cn(
            "pointer-events-none absolute right-0 bottom-0 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border px-0.5 text-4xs font-semibold leading-none shadow-sm",
            props.accentColor
              ? "bg-(--provider-accent) text-white"
              : "bg-card text-muted-foreground",
            props.badgeClassName,
          )}
          style={{ borderColor: indicatorBackground }}
          aria-hidden
        >
          {badgeContent === "initials" ? badgeLabel : null}
        </span>
      ) : null}
    </span>
  );
});
