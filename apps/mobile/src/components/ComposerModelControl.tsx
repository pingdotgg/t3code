import type { ModelSelection, ProviderDriverKind } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import {
  buildTraitsTriggerDisplay,
  getPromptControlledTraits,
} from "@t3tools/client-runtime/model-traits";
import type { ModelOption } from "../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../lib/providerOptions";
import { AppText as Text } from "./ui/AppText";
import { ComposerInlineControl } from "./ComposerToolbar";
import { ProviderIcon, ProviderInstanceIcon } from "./ProviderIcon";

export function ComposerModelControl(props: {
  readonly modelOption: ModelOption | null;
  readonly selection: ModelSelection | null;
  readonly provider: ProviderDriverKind | undefined;
  readonly reportedSelection?: ModelSelection | null | undefined;
  readonly prompt: string;
  readonly surfaceColor: string;
  readonly disabled?: boolean;
  readonly size?: "regular" | "large";
  readonly iconOnly?: boolean;
  /** Effort abbreviation instead of the full traits, for a row shared with the editor. */
  readonly compact?: boolean;
  /** Width the control may fill; falls back to the effort abbreviation plus speed when the full traits overflow it. */
  readonly fitWidth?: number;
  readonly onPress: () => void;
}) {
  const descriptors = resolveProviderOptionDescriptors({
    capabilities: props.modelOption?.capabilities,
    selections: props.selection?.options,
  });
  const promptTraits = getPromptControlledTraits(descriptors, props.prompt);
  const traits = props.provider
    ? buildTraitsTriggerDisplay({
        provider: props.provider,
        descriptors,
        primarySelectDescriptorId: promptTraits.primarySelectDescriptor?.id ?? null,
        ultrathinkPromptControlled: promptTraits.ultrathinkPromptControlled,
        modelSelection: props.selection,
        reportedModelSelection: props.reportedSelection,
      })
    : null;
  const summary = traits?.label ?? "";
  const [fullWidth, setFullWidth] = useState(0);
  const overflows = props.fitWidth !== undefined && fullWidth > 0 && fullWidth > props.fitWidth + 1;
  const compact = props.compact === true || overflows;
  const badge = props.modelOption?.providerBadge;
  const label = props.modelOption?.label ?? props.selection?.model ?? "Choose model";
  const visibleSummary = props.compact
    ? (traits?.compactEffortLabel ?? "")
    : overflows
      ? [traits?.compactEffortLabel, traits?.speedLabel].filter(Boolean).join(" ")
      : summary;
  const renderControl = (full: boolean) => (
    <ComposerInlineControl
      accessibilityLabel={[
        "Model and reasoning settings",
        label,
        badge?.showBadge ? badge.displayName : null,
        summary,
      ]
        .filter(Boolean)
        .join(", ")}
      size={props.size}
      disabled={props.disabled}
      emphasized
      renderIcon={(size) =>
        badge?.showBadge ? (
          <ProviderInstanceIcon
            iconUrl={props.modelOption?.providerIconUrl}
            provider={props.modelOption?.providerDriver}
            displayName={badge.displayName}
            accentColor={badge.accentColor}
            showBadge
            surfaceColor={props.surfaceColor}
            size={size}
          />
        ) : (
          <ProviderIcon
            iconUrl={props.modelOption?.providerIconUrl}
            provider={props.modelOption?.providerDriver}
            size={size}
          />
        )
      }
      label={props.modelOption?.shortName ?? label}
      iconOnly={props.iconOnly}
      // Only short abbreviations keep their width; an unrecognized effort name truncates.
      suffixFixed={!full && compact && (traits?.compactEffortLabel?.length ?? 0) <= 4}
      suffix={
        (full ? summary : visibleSummary) ? (
          <Text
            className={
              props.size === "large"
                ? "text-sm text-foreground-muted"
                : "text-xs text-foreground-muted"
            }
            numberOfLines={1}
          >
            {full ? summary : visibleSummary}
          </Text>
        ) : undefined
      }
      maxWidth={full ? 10_000 : "100%"}
      onPress={props.onPress}
    />
  );
  if (props.fitWidth === undefined) return renderControl(false);
  return (
    <>
      {/* Unconstrained copy measures whether the full labels fit. */}
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ position: "absolute", left: 0, top: 0, width: 10_000, opacity: 0 }}
      >
        <View
          className="self-start"
          onLayout={(event) => setFullWidth(event.nativeEvent.layout.width)}
        >
          {renderControl(true)}
        </View>
      </View>
      {renderControl(false)}
    </>
  );
}
