import {
  PROVIDER_INSTANCE_BADGE_LABEL_MAX_CHARS,
  providerInstanceInitials,
} from "@t3tools/client-runtime/state/provider-instance-display";
import { PROVIDER_INSTANCE_INITIALS_ICON, type ProviderDriverKind } from "@t3tools/contracts";

import { PROVIDER_INSTANCE_LOGO_OPTIONS, ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const DEFAULT_ICON_VALUE = "default";

/**
 * Glyph and badge-label pickers for one provider instance, so instances that
 * share a driver (several Claude-compatible APIs, say) can look different.
 */
export function ProviderInstanceAppearanceControls(props: {
  readonly instanceId: string;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly accentColor: string | undefined;
  readonly icon: string | undefined;
  readonly badgeLabel: string | undefined;
  readonly onIconChange: (icon: string | undefined) => void;
  readonly onBadgeLabelChange: (badgeLabel: string | undefined) => void;
}) {
  const options = [
    { value: DEFAULT_ICON_VALUE, label: "Provider default", icon: undefined },
    ...PROVIDER_INSTANCE_LOGO_OPTIONS.map((option) => ({
      value: option.icon as string,
      label: option.label,
      icon: option.icon as string | undefined,
    })),
    {
      value: PROVIDER_INSTANCE_INITIALS_ICON,
      label: "Badge label",
      icon: PROVIDER_INSTANCE_INITIALS_ICON as string | undefined,
    },
  ];
  // A value from a newer client is kept, but shown as the default it renders as.
  const selected = options.find((option) => option.value === props.icon) ?? options[0]!;
  const renderGlyph = (icon: string | undefined) => (
    <ProviderInstanceIcon
      driverKind={props.driverKind}
      displayName={props.displayName}
      accentColor={props.accentColor}
      icon={icon}
      badgeLabel={props.badgeLabel}
      className="size-4"
      iconClassName="size-4"
    />
  );

  return (
    <>
      <Select
        value={selected.value}
        onValueChange={(value) => {
          if (value === null) return;
          props.onIconChange(value === DEFAULT_ICON_VALUE ? undefined : value);
        }}
      >
        <SelectTrigger
          size="sm"
          className="min-w-0 flex-1 @min-[32rem]/settings-row:w-40 @min-[32rem]/settings-row:flex-none"
          aria-label={`Icon for ${props.displayName}`}
        >
          <SelectValue>
            <span className="flex min-w-0 items-center gap-2">
              {renderGlyph(selected.icon)}
              <span className="truncate">{selected.label}</span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span className="flex items-center gap-2">
                {renderGlyph(option.icon)}
                {option.label}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <DraftInput
        id={`provider-instance-${props.instanceId}-badge-label`}
        size="sm"
        className="w-16 shrink-0"
        value={props.badgeLabel ?? ""}
        onCommit={(value) => {
          const clipped = Array.from(value.trim())
            .slice(0, PROVIDER_INSTANCE_BADGE_LABEL_MAX_CHARS)
            .join("");
          props.onBadgeLabelChange(clipped || undefined);
        }}
        placeholder={providerInstanceInitials(props.displayName)}
        aria-label={`Badge label for ${props.displayName}`}
        spellCheck={false}
      />
    </>
  );
}
