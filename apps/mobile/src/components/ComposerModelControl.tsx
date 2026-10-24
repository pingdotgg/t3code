import type { ModelSelection, ProviderDriverKind } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import {
  buildTraitsTriggerDisplay,
  getPromptControlledTraits,
} from "@t3tools/client-runtime/model-traits";
import { composerModelLabel } from "@t3tools/client-runtime/model-label";
import type { ModelOption } from "../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../lib/providerOptions";
import { AppText as Text } from "./ui/AppText";
import { ComposerInlineControl } from "./ComposerToolbar";
import { ProviderIcon, ProviderInstanceIcon } from "./ProviderIcon";

const SUFFIX_EXCLUDED_DESCRIPTOR_IDS: ReadonlySet<string> = new Set(["agent", "_t3/session-mode"]);
const NATURAL_WIDTH_PROBE_WIDTH = 2000;

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
  readonly onPress: () => void;
}) {
  const descriptors = resolveProviderOptionDescriptors({
    capabilities: props.modelOption?.capabilities,
    selections: props.selection?.options,
  });
  const promptTraits = getPromptControlledTraits(descriptors, props.prompt);
  const traitsSummary = (visibleDescriptors: typeof descriptors) =>
    props.provider
      ? buildTraitsTriggerDisplay({
          provider: props.provider,
          descriptors: visibleDescriptors,
          primarySelectDescriptorId: promptTraits.primarySelectDescriptor?.id ?? null,
          ultrathinkPromptControlled: promptTraits.ultrathinkPromptControlled,
          modelSelection: props.selection,
          reportedModelSelection: props.reportedSelection,
        }).label
      : "";
  const summary = traitsSummary(
    descriptors.filter((descriptor) => !SUFFIX_EXCLUDED_DESCRIPTOR_IDS.has(descriptor.id)),
  );
  const fullSummary = traitsSummary(descriptors);
  const badge = props.modelOption?.providerBadge;
  const label = props.modelOption?.label ?? props.selection?.model ?? "Choose model";
  const displayLabel = props.modelOption
    ? composerModelLabel(props.modelOption.shortName ?? props.modelOption.label)
    : label;
  const suffix = summary ? (
    <Text
      className={
        props.size === "large" ? "text-sm text-foreground-muted" : "text-xs text-foreground-muted"
      }
      numberOfLines={1}
    >
      {summary}
    </Text>
  ) : undefined;
  const [roomWidth, setRoomWidth] = useState(0);
  const [naturalWidth, setNaturalWidth] = useState<{
    readonly key: string;
    readonly width: number;
  } | null>(null);
  const naturalWidthKey = `${props.size ?? "regular"}\u0000${displayLabel}\u0000${summary}`;
  const measuresSuffix = suffix !== undefined && !props.iconOnly;
  const showsSuffix =
    measuresSuffix && naturalWidth?.key === naturalWidthKey && naturalWidth.width <= roomWidth;
  return (
    <View
      className={props.iconOnly ? "min-w-0 shrink" : "min-w-0 flex-1 items-end"}
      onLayout={(event) => setRoomWidth(event.nativeEvent.layout.width)}
    >
      {measuresSuffix ? (
        <View
          accessibilityElementsHidden
          className="absolute left-0 top-0 items-start opacity-0"
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={{ width: NATURAL_WIDTH_PROBE_WIDTH }}
        >
          <View
            key={naturalWidthKey}
            onLayout={(event) => {
              const width = event.nativeEvent.layout.width;
              setNaturalWidth((current) =>
                current?.key === naturalWidthKey && current.width === width
                  ? current
                  : { key: naturalWidthKey, width },
              );
            }}
          >
            <ComposerInlineControl
              size={props.size}
              emphasized
              static
              renderIcon={() => null}
              label={displayLabel}
              suffix={suffix}
              maxWidth="100%"
            />
          </View>
        </View>
      ) : null}
      <ComposerInlineControl
        accessibilityLabel={[
          "Model and reasoning settings",
          label,
          badge?.showBadge ? badge.displayName : null,
          fullSummary,
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
        label={displayLabel}
        iconOnly={props.iconOnly}
        suffix={showsSuffix ? suffix : undefined}
        maxWidth="100%"
        onPress={props.onPress}
      />
    </View>
  );
}
