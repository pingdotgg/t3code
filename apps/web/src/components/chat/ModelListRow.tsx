import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { type CSSProperties, memo } from "react";
import { CheckIcon, StarIcon } from "lucide-react";
import { getDisplayModelName } from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Kbd } from "../ui/kbd";
import { cn } from "~/lib/utils";
import { modelPickerModelKey } from "./modelPickerKeys";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

/** Where the pick's dots end up, in px from the badge: six, evenly around it. */
const PICK_BURST = Array.from({ length: 6 }, (_, i) => {
  const angle = (i / 6) * Math.PI * 2;
  return [Math.round(Math.cos(angle) * 16), Math.round(Math.sin(angle) * 16)] as const;
});

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  slug: string;
  name: string;
  subProvider?: string | undefined;
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  isFavorite: boolean;
  isSelected: boolean;
  /** Marks this instance apart from another of the same provider. */
  showInstanceBadge: boolean;
  showNewBadge?: boolean;
  unavailable?: boolean;
  jumpLabel?: string | null;
  disabledReason?: string | null;
  onToggleFavorite: (instanceId: ProviderInstanceId, slug: string) => void;
}) {
  const gt = useGT();
  const model = {
    slug: props.slug,
    name: props.name,
    subProvider: props.subProvider,
  };

  const row = (
    <ComboboxItem
      hideIndicator
      selectedFill={false}
      variant="card"
      index={props.index}
      value={modelPickerModelKey(props.instanceId, props.slug)}
      disabled={Boolean(props.disabledReason)}
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
      )}
    >
      {/* One line per model: a tinted logo tile, the name, and the provider in mono. */}
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] transition-transform duration-200 ease-spring group-hover:-rotate-6 group-hover:scale-110",
          props.isSelected && "animate-pick-pop motion-reduce:animate-none",
        )}
        style={
          props.providerAccentColor
            ? {
                backgroundColor: `color-mix(in srgb, ${props.providerAccentColor} 16%, transparent)`,
              }
            : undefined
        }
      >
        <ProviderInstanceIcon
          driverKind={props.driverKind}
          displayName={props.providerDisplayName}
          accentColor={props.providerAccentColor}
          acpRegistryAgentId={props.acpRegistryAgentId}
          acpRegistryIconUrl={props.acpRegistryIconUrl}
          showBadge={props.showInstanceBadge}
          className="size-4"
          iconClassName="size-4"
          indicatorBackground="var(--popover)"
          badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs"
        />
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <div
          className="min-w-0 truncate font-semibold text-sm leading-snug"
          // Names the row in full on hover only when it is cut off.
          onPointerEnter={(event) => {
            const name = event.currentTarget;
            name.title = name.scrollWidth > name.clientWidth ? getDisplayModelName(model) : "";
          }}
        >
          {getDisplayModelName(model)}
        </div>
        {props.subProvider ? (
          <span className="min-w-0 shrink truncate text-muted-foreground/70 text-xs">
            {props.subProvider}
          </span>
        ) : null}
        <span className="min-w-0 shrink-[2] truncate font-mono text-2xs text-muted-foreground/70">
          {props.providerDisplayName}
        </span>
        {props.showNewBadge ? (
          <span
            className="shrink-0 rounded border border-update/35 bg-update/15 px-0.5 py-px font-bold text-3xs text-update-foreground uppercase leading-none tracking-wide"
            aria-label={gt("New model")}
          >
            {gt("New", { $context: "badge on a newly added model" })}
          </span>
        ) : null}
        {props.unavailable ? (
          <Badge variant="outline" size="sm">
            <T context="badge on a model that cannot be selected">Unavailable</T>
          </Badge>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <SharedTooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              onClick={(event) => {
                event.stopPropagation();
                props.onToggleFavorite(props.instanceId, props.slug);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
              }}
              disabled={Boolean(props.disabledReason)}
              aria-label={props.isFavorite ? gt("Remove from favorites") : gt("Add to favorites")}
            >
              <StarIcon
                className={cn(
                  "size-3.5 sm:size-3",
                  props.isFavorite && "fill-current text-warning",
                  !props.isFavorite &&
                    "opacity-0 group-hover:opacity-100 group-data-highlighted:opacity-100 in-focus-visible:opacity-100 pointer-coarse:opacity-100",
                )}
              />
            </Button>
          }
          label={props.isFavorite ? gt("Remove from favorites") : gt("Add to favorites")}
          align="center"
        />
        {props.jumpLabel ? <Kbd>{props.jumpLabel}</Kbd> : null}
        {props.isSelected ? (
          <span
            aria-hidden="true"
            className="relative flex size-4 animate-pick-pop items-center justify-center rounded-full bg-primary text-primary-foreground motion-reduce:animate-none"
          >
            <CheckIcon className="size-2.5" />
            {/* Dots fly out of the badge once, as the pick lands. */}
            {PICK_BURST.map(([x, y]) => (
              <span
                key={`${x}:${y}`}
                className="absolute top-1/2 left-1/2 -mt-0.5 -ml-0.5 size-1 animate-pick-burst rounded-full bg-primary motion-reduce:hidden"
                style={{ "--burst-x": `${x}px`, "--burst-y": `${y}px` } as CSSProperties}
              />
            ))}
          </span>
        ) : null}
      </div>
    </ComboboxItem>
  );

  if (!props.disabledReason) {
    return row;
  }

  return (
    <SharedTooltipTrigger render={row} label={props.disabledReason} side="left" align="center" />
  );
});
