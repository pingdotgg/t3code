// Fork: Kaluwa's Extensions page. Small pieces the views share.
import type { ExtensionHealth, ExtensionKind, ExtensionsSubscription } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import {
  BookOpenIcon,
  CheckIcon,
  GlobeIcon,
  KeyRoundIcon,
  LibraryIcon,
  PuzzleIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { subscriptionNeedsBadge, useExtensions } from "./extensionsContext";
import {
  type ExtensionEntry,
  type ExtensionPresence,
  entryDiffers,
  presenceHealth,
  shownHealth,
} from "./extensionsModel";

export function SubscriptionIcon({
  subscription,
  size = "default",
}: {
  readonly subscription: ExtensionsSubscription;
  readonly size?: "default" | "compact";
}) {
  const { list } = useExtensions();
  return (
    <ProviderInstanceIcon
      driverKind={subscription.driver}
      displayName={subscription.displayName}
      accentColor={subscription.accentColor ?? undefined}
      showBadge={subscriptionNeedsBadge(list.subscriptions, subscription)}
      size={size}
      indicatorBackground="var(--background)"
    />
  );
}

export function KindIcon({ entry }: { readonly entry: ExtensionEntry }) {
  const Icon =
    entry.kind === "plugin"
      ? PuzzleIcon
      : entry.kind === "skill"
        ? entry.inLibrary
          ? LibraryIcon
          : BookOpenIcon
        : entry.transport === "stdio"
          ? TerminalIcon
          : GlobeIcon;
  return (
    <span
      aria-hidden
      className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground"
    >
      <Icon className="size-3.5" />
    </span>
  );
}

export function useKindLabels() {
  const gt = useGT();
  return {
    plural: (kind: ExtensionKind) =>
      kind === "mcp" ? gt("MCP servers") : kind === "plugin" ? gt("Plugins") : gt("Skills"),
    singular: (kind: ExtensionKind) =>
      kind === "mcp" ? gt("MCP server") : kind === "plugin" ? gt("Plugin") : gt("Skill"),
  };
}

export function useHealthLabel() {
  const gt = useGT();
  const { checking } = useExtensions();
  return (entry: ExtensionEntry, presence: ExtensionPresence) => {
    const health = presenceHealth(presence);
    switch (health) {
      case "ok":
        return entry.kind === "mcp"
          ? gt("Connected")
          : gt("Working", { $context: "status of an installed extension" });
      case "needsAuth":
        return gt("Needs sign-in");
      case "failing":
        return gt("Failing", { $context: "status of an installed extension" });
      case "disabled":
        return gt("Off", { $context: "status of a turned-off extension" });
      case "unknown":
        if (entry.kind === "plugin") return gt("Installed");
        if (entry.kind === "skill") {
          return presence.skillSource === "library"
            ? gt("Linked", { $context: "a skill linked from the shared library" })
            : gt("Local", { $context: "a skill that lives only in this subscription" });
        }
        return checking ? gt("Checking…") : gt("Not checked");
    }
  };
}

const HEALTH_TEXT_CLASS: Record<ExtensionHealth, string> = {
  ok: "text-success-foreground",
  needsAuth: "text-warning-foreground",
  failing: "text-destructive-foreground",
  disabled: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

export function HealthGlyph({ health }: { readonly health: ExtensionHealth }) {
  if (health === "needsAuth") {
    return <KeyRoundIcon aria-hidden className="size-3.5 shrink-0 text-warning-foreground" />;
  }
  if (health === "failing") {
    return (
      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-destructive-foreground" />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        health === "ok" && "bg-success",
        health === "disabled" && "border border-muted-foreground/60",
        health === "unknown" && "bg-muted-foreground/40",
      )}
    />
  );
}

export function HealthStatus({
  entry,
  presence,
  className,
}: {
  readonly entry: ExtensionEntry;
  readonly presence: ExtensionPresence;
  readonly className?: string;
}) {
  const label = useHealthLabel();
  const health = shownHealth(entry.kind, presence);
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs",
        HEALTH_TEXT_CLASS[health],
        className,
      )}
    >
      <HealthGlyph health={health} />
      <span className="truncate">{label(entry, presence)}</span>
    </span>
  );
}

export function EntryTags({
  entry,
  presence,
}: {
  readonly entry: ExtensionEntry;
  /** Shows this subscription's own version instead of the first one found. */
  readonly presence?: ExtensionPresence | undefined;
}) {
  const gt = useGT();
  const version = presence ? presence.location : entry.version;
  return (
    <>
      {entry.transport ? (
        <Badge variant="outline" size="sm">
          {entry.transport}
        </Badge>
      ) : null}
      {entry.kind === "plugin" && version ? (
        <Badge variant="outline" size="sm">
          {version}
        </Badge>
      ) : null}
      {presence?.managedElsewhere ? (
        <Tooltip>
          <TooltipTrigger render={<Badge variant="secondary" size="sm" />}>
            <T>Managed by provider</T>
          </TooltipTrigger>
          <TooltipPopup>
            {gt("An account-level connector. Change it on the provider's website.")}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {entry.kind === "skill" && entry.inLibrary ? (
        <Badge variant="info" size="sm">
          <T>Library</T>
        </Badge>
      ) : null}
      {entryDiffers(entry) ? (
        <Tooltip>
          <TooltipTrigger render={<Badge variant="warning" size="sm" />}>
            <T>Differs</T>
          </TooltipTrigger>
          <TooltipPopup>
            {entry.kind === "mcp"
              ? gt("Same name, but a different command or URL between subscriptions.")
              : entry.kind === "plugin"
                ? gt("Subscriptions have different versions of this plugin.")
                : gt("Subscriptions have separate copies of this skill.")}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  );
}

/** The name, its tags and one muted line under it. */
export function EntryTitle({
  entry,
  presence,
  children,
}: {
  readonly entry: ExtensionEntry;
  /** Shows this subscription's own target and version, which can differ from the others'. */
  readonly presence?: ExtensionPresence | undefined;
  readonly children?: ReactNode;
}) {
  const subline =
    entry.kind === "mcp"
      ? (presence?.location ?? entry.target)
      : entry.kind === "plugin"
        ? [entry.description, entry.marketplace].filter(Boolean).join(" · ")
        : entry.description;
  return (
    <span className="flex min-w-0 flex-col gap-0.5 text-start">
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="min-w-0 truncate text-sm font-medium">{entry.name}</span>
        <EntryTags entry={entry} presence={presence} />
        {children}
      </span>
      {subline ? (
        <span
          className={cn(
            "min-w-0 truncate text-xs text-muted-foreground",
            entry.kind === "mcp" && "font-mono",
          )}
        >
          {subline}
        </span>
      ) : null}
    </span>
  );
}

/** A changing control: disabled with a reason when this device may not change provider config. */
export function EditButton({
  busy = false,
  busyLabel,
  disabled,
  children,
  ...props
}: React.ComponentProps<typeof Button> & {
  readonly busy?: boolean;
  readonly busyLabel?: string;
}) {
  const gt = useGT();
  const { canEdit } = useExtensions();
  const button = (
    <Button {...props} disabled={disabled || busy || !canEdit} aria-busy={busy}>
      {busy ? <Spinner /> : null}
      {busy && busyLabel ? busyLabel : children}
    </Button>
  );
  if (canEdit) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{button}</TooltipTrigger>
      <TooltipPopup>{gt("You don't have permission to change extensions here.")}</TooltipPopup>
    </Tooltip>
  );
}

export function AllClear({ children }: { readonly children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm text-muted-foreground">
      <CheckIcon aria-hidden className="size-4 shrink-0 text-success-foreground" />
      <span>{children}</span>
    </p>
  );
}

export function SectionCard({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("divide-y overflow-hidden rounded-lg border bg-card/40", className)}
      {...props}
    />
  );
}
