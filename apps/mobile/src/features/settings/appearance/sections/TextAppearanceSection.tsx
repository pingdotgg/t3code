import {
  BASE_FONT_SIZE_STEP,
  DEFAULT_BASE_FONT_SIZE,
  MAX_BASE_FONT_SIZE,
  MIN_BASE_FONT_SIZE,
} from "../../../../lib/appearancePreferences";
import { SettingsSection } from "../../components/SettingsSection";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";
import {
  AppearancePreviewSeparator,
  TextAppearancePreview,
} from "../components/AppearancePreviews";
import { FontSizeSliderRow } from "../components/FontSizeSliderRow";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";

export function TextAppearanceSection() {
  const { isReady, appearance, setBaseFontSize, mathRenderingEnabled, setMathRenderingEnabled } =
    useAppearancePreferences();

  return (
    <SettingsSection title="Text">
      <TextAppearancePreview fontSize={appearance.baseFontSize} />
      <AppearancePreviewSeparator />
      <FontSizeSliderRow
        disabled={!isReady}
        icon="textformat.size"
        label="Text size"
        max={MAX_BASE_FONT_SIZE}
        min={MIN_BASE_FONT_SIZE}
        onChange={setBaseFontSize}
        step={BASE_FONT_SIZE_STEP}
        value={appearance.baseFontSize}
        valueLabel={`${appearance.baseFontSize} pt`}
        resetVisible
        resetDisabled={appearance.baseFontSize === DEFAULT_BASE_FONT_SIZE}
        onReset={() => setBaseFontSize(DEFAULT_BASE_FONT_SIZE)}
      />
      <SettingsSwitchRow
        disabled={!isReady}
        icon="plusminus"
        label="Render math"
        value={mathRenderingEnabled}
        onValueChange={setMathRenderingEnabled}
        resetVisible
        resetDisabled={!mathRenderingEnabled}
        onReset={() => setMathRenderingEnabled(false)}
      />
    </SettingsSection>
  );
}
