import { View } from "react-native";
import { EnrichedMarkdownText } from "react-native-enriched-markdown";

/** Draws `formulaMarkdown` output as one paragraph that passes touches to the control around it. */
export function FormulaText(props: {
  readonly markdown: string;
  readonly color: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly writingDirection?: "ltr" | "rtl";
  readonly textAlign?: "left" | "right";
}) {
  return (
    <View pointerEvents="none">
      <EnrichedMarkdownText
        markdown={props.markdown}
        markdownStyle={{
          paragraph: {
            color: props.color,
            fontFamily: props.fontFamily,
            fontSize: props.fontSize,
            lineHeight: props.lineHeight,
            marginTop: 0,
            marginBottom: 0,
            ...(props.textAlign ? { textAlign: props.textAlign } : null),
          },
          inlineMath: { color: props.color },
        }}
        md4cFlags={{ latexMath: true, hardSoftBreaks: true, preserveBlankLines: true }}
        writingDirection={props.writingDirection}
        selectable={false}
      />
    </View>
  );
}
