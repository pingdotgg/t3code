import type { ModelSelection, ProviderDriverKind } from "@t3tools/contracts";
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
  readonly onPress: () => void;
}) {
  const descriptors = resolveProviderOptionDescriptors({
    capabilities: props.modelOption?.capabilities,
    selections: props.selection?.options,
  });
  const promptTraits = getPromptControlledTraits(descriptors, props.prompt);
  const summary = props.provider
    ? buildTraitsTriggerDisplay({
        provider: props.provider,
        descriptors,
        primarySelectDescriptorId: promptTraits.primarySelectDescriptor?.id ?? null,
        ultrathinkPromptControlled: promptTraits.ultrathinkPromptControlled,
        modelSelection: props.selection,
        reportedModelSelection: props.reportedSelection,
      }).label
    : "";
  const badge = props.modelOption?.providerBadge;
  const label = props.modelOption?.label ?? props.selection?.model ?? "Choose model";
  return (
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
      suffix={
        summary ? (
          <Text
            className={
              props.size === "large"
                ? "text-sm text-foreground-muted"
                : "text-xs text-foreground-muted"
            }
            numberOfLines={1}
          >
            {summary}
          </Text>
        ) : undefined
      }
      maxWidth="100%"
      onPress={props.onPress}
    />
  );
}
