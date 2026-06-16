import React from "react";
import { Platform, StyleSheet, Text as RNText, type TextProps, type ViewStyle } from "react-native";
import T3MarkdownTextRunNativeComponent from "./T3MarkdownTextRunNativeComponent";
import T3MarkdownTextNativeComponent from "./T3MarkdownTextNativeComponent";
import { flattenStyles } from "./util";

const TextAncestorContext = React.createContext<[boolean, ViewStyle]>([
  false,
  StyleSheet.create({}),
]);

const textDefaults: TextProps = {
  allowFontScaling: true,
  selectable: true,
};

const useTextAncestorContext = () => React.useContext(TextAncestorContext);

/**
 * Event fired by `onSelectionChange`. `start`/`end` are 0-based UTF-16 indices
 * into the rendered string. `start === end` means the selection was cleared.
 */
export type SelectionChangeEvent = {
  nativeEvent: { target: number; start: number; end: number };
};

export type MarkdownTextPrimitiveProps = TextProps & {
  uiTextView?: boolean;
  /**
   * Fired when the native text selection changes. Only fires on iOS when
   * `uiTextView` is true. Note: fires on every selection-edge adjustment
   * (e.g. dragging a selection handle), so consumers driving expensive work
   * off this event should debounce.
   */
  onSelectionChange?: (event: SelectionChangeEvent) => void;
};

function MarkdownTextPrimitiveChild({ style, children, ...rest }: MarkdownTextPrimitiveProps) {
  const [isAncestor, rootStyle] = useTextAncestorContext();

  // Flatten the styles, and apply the root styles when needed
  const flattenedStyle = React.useMemo(() => flattenStyles(rootStyle, style), [rootStyle, style]);
  const contextValue = React.useMemo<[boolean, ViewStyle]>(
    () => [true, flattenedStyle],
    [flattenedStyle],
  );
  let childPosition = 0;
  const nativeChildren = React.Children.toArray(children).map((child) => {
    const position = childPosition;
    childPosition += 1;

    if (React.isValidElement(child)) {
      return child;
    }
    if (typeof child !== "string" && typeof child !== "number") {
      return null;
    }

    const text = child.toString();
    return (
      // @ts-expect-error The generated run props do not include inherited Text props.
      <T3MarkdownTextRunNativeComponent
        key={`text-${position}-${text.length}-${text}`}
        style={flattenedStyle}
        text={text}
        {...rest}
      />
    );
  });

  if (!isAncestor) {
    return (
      <TextAncestorContext.Provider value={contextValue}>
        <T3MarkdownTextNativeComponent
          {...textDefaults}
          {...rest}
          // ellipsizeMode={rest.ellipsizeMode ?? rest.lineBreakMode ?? 'tail'}
          style={[flattenedStyle]}
          // @ts-expect-error Weirdness
          onPress={undefined}
          onLongPress={undefined}
        >
          {nativeChildren}
        </T3MarkdownTextNativeComponent>
      </TextAncestorContext.Provider>
    );
  }

  return <>{nativeChildren}</>;
}

function MarkdownTextPrimitiveInner(props: MarkdownTextPrimitiveProps) {
  const [isAncestor] = useTextAncestorContext();

  // Even if the uiTextView prop is set, we can still default to using
  // normal selection (i.e. base RN text) if the text doesn't need to be
  // selectable
  if ((!props.selectable || !props.uiTextView) && !isAncestor) {
    return <RNText {...props} />;
  }
  return <MarkdownTextPrimitiveChild {...props} />;
}

export function MarkdownTextPrimitive(props: MarkdownTextPrimitiveProps) {
  if (Platform.OS !== "ios") {
    return <RNText {...props} />;
  }
  return <MarkdownTextPrimitiveInner {...props} />;
}
