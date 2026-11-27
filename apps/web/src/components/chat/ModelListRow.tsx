import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { memo } from "react";
import { CheckIcon, StarIcon } from "lucide-react";
import { getDisplayModelName, getProviderRowLabel } from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Kbd } from "../ui/kbd";
import { cn } from "~/lib/utils";
import { modelPickerModelKey } from "./modelPickerKeys";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

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
  showProvider: boolean;
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
  const providerLabel = getProviderRowLabel(props.providerDisplayName, props.subProvider);

  const row = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={modelPickerModelKey(props.instanceId, props.slug)}
      disabled={Boolean(props.disabledReason)}
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
      )}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <div
            className={cn(
              "min-w-0 truncate text-label group-data-highlighted:text-foreground",
              props.isSelected
                ? "text-foreground"
                : "text-(--model-picker-label,var(--foreground))",
            )}
            // Names the row in full on hover only when it is cut off.
            onPointerEnter={(event) => {
              const name = event.currentTarget;
              name.title = name.scrollWidth > name.clientWidth ? getDisplayModelName(model) : "";
            }}
          >
            {getDisplayModelName(model)}
          </div>
          {props.isSelected ? <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" /> : null}
          {props.showNewBadge ? (
            <span
              className="shrink-0 rounded-model-tag border border-transparent bg-badge-neutral px-0.5 py-px text-3xs font-bold leading-none text-muted-foreground"
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
        {props.showProvider && (
          <div className="mt-1 flex items-center gap-1.5">
            <ProviderInstanceIcon
              driverKind={props.driverKind}
              displayName={props.providerDisplayName}
              acpRegistryAgentId={props.acpRegistryAgentId}
              acpRegistryIconUrl={props.acpRegistryIconUrl}
              className="size-3"
              iconClassName="size-3 opacity-60"
            />
            <span className="truncate text-meta font-normal text-dim-foreground">
              {providerLabel}
            </span>
          </div>
        )}
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
                  props.isFavorite && "fill-current text-warning-foreground",
                )}
              />
            </Button>
          }
          label={props.isFavorite ? gt("Remove from favorites") : gt("Add to favorites")}
          align="center"
        />
        {props.jumpLabel ? <Kbd>{props.jumpLabel}</Kbd> : null}
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
