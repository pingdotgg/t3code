import { codegenNativeComponent, type CodegenTypes } from "react-native";
import type { ViewProps } from "react-native";

interface TargetedEvent {
  target: CodegenTypes.Int32;
}

/**
 * Event fired when text selection changes in the SourceText.
 * @property target - The view tag identifier
 * @property start - The start index of the selected range (0-based)
 * @property end - The end index of the selected range (0-based, exclusive)
 */
interface SelectionChangeEvent extends TargetedEvent {
  start: CodegenTypes.Int32;
  end: CodegenTypes.Int32;
}

type EllipsizeMode = "head" | "middle" | "tail" | "clip";

interface NativeProps extends ViewProps {
  numberOfLines?: CodegenTypes.Int32;
  allowFontScaling?: CodegenTypes.WithDefault<boolean, true>;
  ellipsizeMode?: CodegenTypes.WithDefault<EllipsizeMode, "tail">;
  selectable?: boolean;
  /**
   * Callback fired when the text selection changes.
   *
   * @example
   * ```tsx
   * <SourceText
   *   onSelectionChange={(event) => {
   *     console.log('Selection:', event.nativeEvent.start, event.nativeEvent.end);
   *   }}
   * >
   *   Selectable text
   * </SourceText>
   * ```
   */
  onSelectionChange?: CodegenTypes.BubblingEventHandler<SelectionChangeEvent>;
}

export default codegenNativeComponent<NativeProps>("T3SourceText", {
  excludedPlatforms: ["android"],
});
