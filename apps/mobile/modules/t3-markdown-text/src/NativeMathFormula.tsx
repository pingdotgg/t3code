import { memo, useMemo } from "react";
import { Platform, ScrollView, View } from "react-native";
import { SvgXml } from "react-native-svg";

import { CopyTextButton } from "./CopyTextButton";
import { MarkdownTextPrimitive } from "./MarkdownTextPrimitive";
import { mathSvg } from "./mathSvg";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";

export default memo(function NativeMathFormula(props: {
  readonly source: string;
  readonly display: boolean;
  readonly textStyle: NativeMarkdownTextStyle;
}) {
  const { source, display, textStyle } = props;
  const svg = useMemo(
    () => mathSvg(source, display, textStyle.fontSize),
    [source, display, textStyle.fontSize],
  );
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}>
      <ScrollView
        horizontal
        bounces={false}
        nestedScrollEnabled={Platform.OS === "android"}
        style={{ flex: 1 }}
        contentContainerStyle={{ alignItems: "center", paddingVertical: 4 }}
      >
        {svg ? (
          <View accessible accessibilityRole="image" accessibilityLabel={source}>
            <SvgXml xml={svg.xml} width={svg.width} height={svg.height} color={textStyle.color} />
          </View>
        ) : (
          <MarkdownTextPrimitive
            selectable
            style={{ color: textStyle.color, fontSize: textStyle.fontSize }}
          >
            {source}
          </MarkdownTextPrimitive>
        )}
      </ScrollView>
      <CopyTextButton
        accessibilityLabel="Copy formula"
        text={display ? `$$\n${source}\n$$` : `\\(${source}\\)`}
        tintColor={textStyle.mutedColor}
        copiedTintColor={textStyle.linkColor}
      />
    </View>
  );
});
