import {
  codegenNativeComponent,
  type CodegenTypes,
  type ColorValue,
  type ViewProps,
} from "react-native";

interface TargetedEvent {
  target: CodegenTypes.Int32;
}

interface ContextMenuActionEvent extends TargetedEvent {
  actionIdentifier: string;
}

type TextDecorationLine = "none" | "underline" | "line-through";

type TextDecorationStyle = "solid" | "double" | "dotted" | "dashed";

export type NativeFontWeight =
  | "normal"
  | "bold"
  | "ultraLight"
  | "light"
  | "medium"
  | "semibold"
  | "heavy";

type FontStyle = "normal" | "italic";

type TextAlign = "auto" | "left" | "right" | "center" | "justify";

interface NativeProps extends ViewProps {
  text: string;
  color?: ColorValue;
  fontSize?: CodegenTypes.Float;
  fontStyle?: CodegenTypes.WithDefault<FontStyle, "normal">;
  fontWeight?: CodegenTypes.WithDefault<NativeFontWeight, "normal">;
  fontFamily?: string;
  letterSpacing?: CodegenTypes.Float;
  lineHeight?: CodegenTypes.Float;
  textDecorationLine?: CodegenTypes.WithDefault<TextDecorationLine, "none">;
  textDecorationStyle?: CodegenTypes.WithDefault<TextDecorationStyle, "solid">;
  textDecorationColor?: ColorValue;
  textAlign?: CodegenTypes.WithDefault<TextAlign, "auto">;
  shadowRadius?: CodegenTypes.WithDefault<CodegenTypes.Float, 0>;
  contextMenuConfig?: string;
  onPress?: CodegenTypes.BubblingEventHandler<TargetedEvent>;
  onLongPress?: CodegenTypes.BubblingEventHandler<TargetedEvent>;
  onContextMenuAction?: CodegenTypes.BubblingEventHandler<ContextMenuActionEvent>;
}

export default codegenNativeComponent<NativeProps>("T3MarkdownTextRun", {
  excludedPlatforms: ["android"],
});
