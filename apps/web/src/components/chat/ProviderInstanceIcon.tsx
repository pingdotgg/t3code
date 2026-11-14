import { type CSSProperties, memo } from "react";

import {
  normalizeProviderAccentColor,
  providerAccentForegroundColor,
  providerInstanceInitials,
  providerInstanceTabMetrics,
} from "@t3tools/client-runtime/state/provider-instance-display";

import { ProviderDriverKind } from "@t3tools/contracts";
import {
  AnthropicIcon,
  AntigravityIcon,
  ClaudeAI,
  Icon,
  OllamaIcon,
  OpenAI,
  OpenRouterIcon,
} from "../Icons";

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
  // Text generators, by the service they reach (see textGeneratorBrand).
  [ProviderDriverKind.make("openai")]: OpenAI,
  [ProviderDriverKind.make("anthropic")]: AnthropicIcon,
  [ProviderDriverKind.make("openrouter")]: OpenRouterIcon,
  [ProviderDriverKind.make("ollama")]: OllamaIcon,
};

const PROVIDER_TEXT_COLOR_BY_PROVIDER: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "text-black dark:text-white",
  [ProviderDriverKind.make("claudeAgent")]: "text-[#d97757]",
  [ProviderDriverKind.make("antigravity")]: "text-[#5b87bf]",
  [ProviderDriverKind.make("openai")]: "text-black dark:text-white",
  [ProviderDriverKind.make("anthropic")]: "text-black dark:text-white",
  [ProviderDriverKind.make("openrouter")]: "text-black dark:text-white",
  [ProviderDriverKind.make("ollama")]: "text-black dark:text-white",
};

const BUNDLED_LOGO_COLOR_BY_PROVIDER: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("claudeAgent")]: "#d97757",
  [ProviderDriverKind.make("antigravity")]: "#5b87bf",
};

/** The logo's own color, or null for logos that swap between black and white per theme. */
export function providerLogoColor(driverKind: ProviderDriverKind): string | null {
  const fill = providerClients.get(driverKind)?.icon?.fill;
  if (fill) return fill.light === fill.dark ? fill.light : null;
  return BUNDLED_LOGO_COLOR_BY_PROVIDER[driverKind] ?? null;
}

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
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  showBadge?: boolean;
  badgeContent?: "initials" | "none";
  /** "corner" keeps the logo centered in a fixed slot; the tab then hangs outside it. */
  badgePlacement?: "inline" | "corner";
  size?: "default" | "compact";
  className?: string;
  iconClassName?: string;
  badgeClassName?: string;
  indicatorBackground?: string;
}) {
  const Icon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;
  const packageIcon = providerClients.get(props.driverKind)?.icon;
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
  const isAcpRegistry = props.driverKind === "acpRegistry";
  // A custom OpenAI-compatible endpoint has no brand: show its name, marked with the protocol.
  const isCustomEndpoint = props.driverKind === "openaiCompatible";
  const acpRegistryIconUrl = resolveProviderInstanceAcpRegistryIconUrl({
    driverKind: props.driverKind,
    agentId: props.acpRegistryAgentId,
    iconUrl: props.acpRegistryIconUrl,
  });

  const tab = providerInstanceTabMetrics(props.size === "compact" ? 14 : 20);
  const rem = (px: number) => `${px / 16}rem`;
  const corner = props.badgePlacement === "corner";
  const initialsTab =
    !isCustomEndpoint && props.showBadge && badgeContent === "initials" ? (
      <span
        className={cn(
          "pointer-events-none z-30 flex shrink-0 items-center justify-center font-bold leading-none tracking-wide",
          accentColor
            ? "bg-(--provider-accent) text-(--provider-accent-foreground)"
            : "text-foreground",
          corner ? "absolute" : "relative",
        )}
        style={{
          height: rem(tab.height),
          ...(corner
            ? { width: rem(tab.cornerWidth) }
            : { padding: `0 ${rem(tab.paddingHorizontal)}` }),
          borderRadius: rem(tab.borderRadius),
          fontSize: rem(tab.fontSize),
          boxShadow: `0 0 0 ${rem(tab.ring)} ${indicatorBackground}`,
          ...(accentColor
            ? {}
            : { background: "color-mix(in srgb, var(--foreground) 24%, var(--background))" }),
          ...(corner
            ? { left: `calc(100% - ${rem(tab.overlap)})`, bottom: rem(-tab.drop) }
            : { marginLeft: rem(-tab.overlap), marginBottom: rem(-tab.drop) }),
        }}
        aria-hidden
      >
        {providerInstanceInitials(props.displayName)}
      </span>
    ) : null;

  const icon = (
    <span
      className={cn(
        "relative isolate z-30 inline-flex shrink-0 items-center justify-center overflow-visible",
        props.className,
      )}
      style={accentStyle}
      data-provider-accent-color={accentColor}
    >
      {isAcpRegistry ? (
        <AcpRegistryAgentIcon
          className={cn("size-5 rounded-none bg-transparent", iconClassName)}
          fallbackClassName="size-full"
          icon={acpRegistryIconUrl}
        />
      ) : isCustomEndpoint ? (
        // The tile is a size container: below ~18px it keeps one letter and drops the mark.
        <span
          className={cn(
            "@container relative flex size-5 shrink-0 items-center justify-center rounded-md border bg-card text-4xs font-semibold leading-none text-foreground",
            iconClassName,
          )}
          aria-hidden
        >
          {Array.from(providerInstanceInitials(props.displayName))[0]}
          <span className="@max-[1.1rem]:hidden">
            {Array.from(providerInstanceInitials(props.displayName)).slice(1).join("")}
          </span>
          <span
            className={cn(
              "pointer-events-none absolute right-[-0.3125rem] bottom-[-0.3125rem] z-10 flex size-3 items-center justify-center rounded-full border bg-card text-foreground shadow-sm @max-[1.1rem]:hidden",
              props.badgeClassName,
            )}
            style={{ borderColor: indicatorBackground }}
          >
            <OpenAI className="size-2" />
          </span>
        </span>
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
          {providerInstanceInitials(props.displayName)}
        </span>
      )}
      {corner ? initialsTab : null}
      {!isCustomEndpoint && props.showBadge && badgeContent === "none" ? (
        <span
          className={cn(
            "pointer-events-none absolute right-0 bottom-0 z-10 flex h-3.5 min-w-3.5 rounded-full border shadow-sm",
            accentColor ? "bg-(--provider-accent)" : "bg-card",
            props.size === "compact" && "right-[-0.1875rem] bottom-[-0.1875rem] h-3 min-w-3",
            props.badgeClassName,
          )}
          style={{ borderColor: indicatorBackground }}
          aria-hidden
        />
      ) : null}
    </span>
  );
  if (!initialsTab || corner) return icon;
  return (
    <span className="inline-flex shrink-0 items-end" style={accentStyle}>
      {icon}
      {initialsTab}
    </span>
  );
});
