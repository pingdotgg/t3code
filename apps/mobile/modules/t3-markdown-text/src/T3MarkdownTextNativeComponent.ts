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

interface TextLayoutEvent extends TargetedEvent {
  lines: string[];
}

/**
 * Event fired when text selection changes in the MarkdownTextPrimitive.
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
  onTextLayout?: BubblingEventHandler<TextLayoutEvent>;
  /**
   * Callback fired when the text selection changes.
   *
   * @example
   * ```tsx
   * <MarkdownTextPrimitive
   *   onSelectionChange={(event) => {
   *     console.log('Selection:', event.nativeEvent.start, event.nativeEvent.end);
   *   }}
   * >
   *   Selectable text
   * </MarkdownTextPrimitive>
   * ```
   */
  onSelectionChange?: BubblingEventHandler<SelectionChangeEvent>;
}

export default codegenNativeComponent<NativeProps>("T3MarkdownText", {
  excludedPlatforms: ["android"],
});
