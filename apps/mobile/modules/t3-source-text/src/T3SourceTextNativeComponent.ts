import codegenNativeComponent from "react-native/Libraries/Utilities/codegenNativeComponent";
import type { ViewProps } from "react-native";
import type {
  BubblingEventHandler,
  Int32,
  WithDefault,
} from "react-native/Libraries/Types/CodegenTypes";

interface TargetedEvent {
  target: Int32;
}

/**
 * Event fired when text selection changes in the SourceText.
 * @property target - The view tag identifier
 * @property start - The start index of the selected range (0-based)
 * @property end - The end index of the selected range (0-based, exclusive)
 */
interface SelectionChangeEvent extends TargetedEvent {
  start: Int32;
  end: Int32;
}

type EllipsizeMode = "head" | "middle" | "tail" | "clip";

interface NativeProps extends ViewProps {
  numberOfLines?: Int32;
  allowFontScaling?: WithDefault<boolean, true>;
  ellipsizeMode?: WithDefault<EllipsizeMode, "tail">;
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
  onSelectionChange?: BubblingEventHandler<SelectionChangeEvent>;
}

export default codegenNativeComponent<NativeProps>("T3SourceText", {
  excludedPlatforms: ["android"],
});
