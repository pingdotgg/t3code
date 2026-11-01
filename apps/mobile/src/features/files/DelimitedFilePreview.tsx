/* oxlint-disable react/no-array-index-key -- Captured table cells have stable positions and may contain identical values. */
import { ScrollView, View } from "react-native";
import type { parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import { AppText as Text } from "../../components/ui/AppText";
import { FilePreviewNotice } from "./FilePreviewFeedback";

export function DelimitedFilePreview(props: {
  readonly table: ReturnType<typeof parseDelimitedPreview>;
}) {
  return (
    <ScrollView className="flex-1">
      {props.table.truncated ? (
        <FilePreviewNotice>
          Table limited to the first 100 rows and 30 columns. Source shows the rest.
        </FilePreviewNotice>
      ) : null}
      <ScrollView horizontal>
        <View>
          {props.table.rows.map((row, rowIndex) => (
            <View key={rowIndex} className={rowIndex === 0 ? "flex-row bg-subtle" : "flex-row"}>
              {row.map((cell, columnIndex) => (
                <View key={columnIndex} className="w-48 border-r border-b border-border px-3 py-2">
                  <Text
                    selectable
                    className={
                      rowIndex === 0
                        ? "text-sm font-t3-semibold text-foreground"
                        : "text-sm text-foreground"
                    }
                  >
                    {cell}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </ScrollView>
  );
}
