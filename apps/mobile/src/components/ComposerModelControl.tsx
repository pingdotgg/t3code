import type { ModelSelection } from "@t3tools/contracts";

import type { ModelOption } from "../lib/modelOptions";
import {
  composerModelOptionSummary,
  resolveProviderOptionDescriptors,
} from "../lib/providerOptions";
import { AppText as Text } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { ComposerInlineControl } from "./ComposerToolbar";
import { ProviderIcon } from "./ProviderIcon";
import { useAndroidControlSizing } from "./useAndroidControlSizing";

/** Keeps option indicators fixed while the model name yields space in a narrow toolbar. */
export function ComposerModelControl(props: {
  readonly modelOption: ModelOption | null | undefined;
  readonly selection: ModelSelection | null;
  readonly reportedSelection?: ModelSelection | null | undefined;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const { scale } = useAndroidControlSizing();
  const label = props.modelOption?.label ?? props.selection?.model ?? "Choose model";
  const { reasoningLabel, speedLabel } = composerModelOptionSummary({
    provider: props.modelOption?.providerDriver,
    descriptors: resolveProviderOptionDescriptors({
      capabilities: props.modelOption?.capabilities,
      selections: props.selection?.options,
    }),
    selection: props.selection,
    reportedSelection: props.reportedSelection,
  });
  return (
    <ComposerInlineControl
      accessibilityLabel={[
        "Model and reasoning settings",
        label,
        reasoningLabel ? `Reasoning: ${reasoningLabel}` : null,
        speedLabel ? `${speedLabel} mode on` : null,
      ]
        .filter(Boolean)
        .join(", ")}
      disabled={props.disabled}
      emphasized
      renderIcon={(size) => (
        <ProviderIcon
          iconUrl={props.modelOption?.providerIconUrl}
          provider={props.modelOption?.providerDriver}
          size={size}
        />
      )}
      label={label}
      suffix={
        reasoningLabel || speedLabel ? (
          <>
            {reasoningLabel ? (
              <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
                {reasoningLabel}
              </Text>
            ) : null}
            {speedLabel ? (
              <SymbolView
                name={{ ios: "bolt", android: "bolt" }}
                size={Math.round(12 * scale)}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
            ) : null}
          </>
        ) : undefined
      }
      maxWidth="100%"
      onPress={props.onPress}
    />
  );
}
