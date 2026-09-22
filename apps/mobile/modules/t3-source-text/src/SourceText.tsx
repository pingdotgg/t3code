import React, { type Ref } from "react";
import { Platform, StyleSheet, Text, type TextProps, type TextStyle } from "react-native";
import T3SourceTextRunNativeComponent from "./T3SourceTextRunNativeComponent";
import T3SourceTextNativeComponent from "./T3SourceTextNativeComponent";
import { flattenStyles } from "./util";

const TextAncestorContext = React.createContext<[boolean, TextStyle]>([false, {}]);

export type SourceTextProps = Omit<TextProps, "onTextLayout" | "onPress" | "onLongPress"> & {
  nativeTextRef?: Ref<Text>;
  onSelectionChange?: (event: {
    nativeEvent: { target: number; start: number; end: number };
  }) => void;
};

/** One selectable document on iOS, with nested runs carrying syntax colors. */
export function SourceText({ style, children, nativeTextRef, ...props }: SourceTextProps) {
  const [isAncestor, rootStyle] = React.useContext(TextAncestorContext);
  const flattenedStyle = React.useMemo(() => flattenStyles(rootStyle, style), [rootStyle, style]);
  const contextValue = React.useMemo<[boolean, TextStyle]>(
    () => [true, StyleSheet.flatten([rootStyle, style])],
    [rootStyle, style],
  );
  if (Platform.OS !== "ios") {
    const { onSelectionChange: _onSelectionChange, ...textProps } = props;
    return (
      <Text ref={nativeTextRef} style={style} {...textProps}>
        {children}
      </Text>
    );
  }
  const runs = React.Children.toArray(children).map((child, index) => {
    if (React.isValidElement(child)) return child;
    if (typeof child !== "string" && typeof child !== "number") return null;
    return (
      <T3SourceTextRunNativeComponent
        key={index}
        style={flattenedStyle}
        {...flattenedStyle}
        text={String(child)}
      />
    );
  });
  if (isAncestor) return <>{runs}</>;
  return (
    <TextAncestorContext.Provider value={contextValue}>
      <T3SourceTextNativeComponent allowFontScaling selectable {...props} style={flattenedStyle}>
        {runs}
      </T3SourceTextNativeComponent>
    </TextAncestorContext.Provider>
  );
}
