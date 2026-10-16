import { codegenNativeComponent, type CodegenTypes } from "react-native";
import type { ViewProps } from "react-native";

interface TargetedEvent {
  target: CodegenTypes.Int32;
}

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
  onSelectionChange?: CodegenTypes.BubblingEventHandler<SelectionChangeEvent>;
}

export default codegenNativeComponent<NativeProps>("T3SourceText", {
  excludedPlatforms: ["android"],
});
