import { type CSSProperties, memo } from "react";

import {
  normalizeProviderAccentColor,
  providerAccentForegroundColor,
  isProviderInstanceInitialsIcon,
  PROVIDER_INSTANCE_LOGO_ICONS,
  providerInstanceInitialsGlyphScale,
  resolveProviderInstanceBadgeLabel,
  resolveProviderInstanceGlyphDriver,
} from "@t3tools/client-runtime/state/provider-instance-display";

import { ProviderDriverKind } from "@t3tools/contracts";
import { AntigravityIcon, ClaudeAI, Icon, OpenAI } from "../Icons";

import { cn } from "~/lib/utils";
import { providerClients } from "../settings/providerDriverMeta";
import { ProviderPackageIcon } from "./ProviderPackageIcon";
import {
  AcpRegistryAgentIcon,
  officialAcpRegistryIconUrlForAgentId,
  resolveOfficialAcpRegistryIconUrl,
} from "../settings/AcpRegistryIcon";

const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("antigravity")]: AntigravityIcon,
};

const PROVIDER_TEXT_COLOR_BY_PROVIDER: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "text-black dark:text-white",
  [ProviderDriverKind.make("claudeAgent")]: "text-[#d97757]",
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

/** Brand text color for a provider label; package glyphs supply theirs as CSS variables. */
export function providerTextColor(driverKind: ProviderDriverKind): {
  readonly className?: string;
  readonly style?: CSSProperties;
} {
  const icon = providerClients.get(driverKind)?.icon;
  if (icon) {
    return {
      className: "text-(--icon-light) dark:text-(--icon-dark)",
      style: { "--icon-light": icon.fill.light, "--icon-dark": icon.fill.dark } as CSSProperties,
    };
  }
  const className = PROVIDER_TEXT_COLOR_BY_PROVIDER[driverKind];
  return className ? { className } : {};
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
  size?: "default" | "compact";
  className?: string;
  iconClassName?: string;
  badgeClassName?: string;
  indicatorBackground?: string;
}) {
  const glyphDriver = resolveProviderInstanceGlyphDriver(props);
  const Icon = PROVIDER_ICON_BY_PROVIDER[glyphDriver] ?? null;
  const drawsInitials = isProviderInstanceInitialsIcon(props.icon);
  const badgeLabel = resolveProviderInstanceBadgeLabel(props);
  const packageIcon = providerClients.get(glyphDriver)?.icon;
  const indicatorBackground = props.indicatorBackground ?? "var(--card)";
  const accentColor = normalizeProviderAccentColor(props.accentColor);
  const accentStyle = accentColor
    ? ({
        "--provider-accent": accentColor,
        "--provider-accent-foreground": providerAccentForegroundColor(accentColor),
      } as CSSProperties)
    : undefined;
  const badgeContent = props.badgeContent ?? "initials";
  const iconClassName = cn(props.size === "compact" && "size-3.5", props.iconClassName);
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
      data-provider-accent-color={accentColor}
    >
      {drawsInitials ? (
        // Container units scale the label with whatever size the caller gives
        // the glyph, from a 12px thread row to the 20px picker rail.
        <span
          className={cn(
            "@container flex size-5 shrink-0 items-center justify-center",
            iconClassName,
            accentColor && "text-(--provider-accent)",
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
          className={cn("size-5 rounded-none bg-transparent", iconClassName)}
          fallbackClassName="size-full"
          icon={acpRegistryIconUrl}
        />
      ) : packageIcon ? (
        <ProviderPackageIcon
          icon={packageIcon}
          className={cn("size-5 shrink-0", iconClassName)}
          aria-hidden
        />
      ) : Icon ? (
        <Icon className={cn("size-5 shrink-0", iconClassName)} aria-hidden />
      ) : (
        <span className={cn("text-3xs font-semibold leading-none", iconClassName)}>
          {badgeLabel}
        </span>
      )}
      {props.showBadge ? (
        <span
          className={cn(
            "pointer-events-none absolute right-0 bottom-0 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border px-0.5 text-4xs font-semibold leading-none shadow-sm",
            accentColor
              ? "bg-(--provider-accent) text-(--provider-accent-foreground)"
              : "bg-card text-muted-foreground",
            props.size === "compact" &&
              "right-[-0.1875rem] bottom-[-0.1875rem] h-3 min-w-3 px-0.5 text-5xs",
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
