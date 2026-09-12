/** @jsxImportSource react */
import type { ReactNode } from "react";
import { Box } from "./Layout.tsx";
import { Text } from "./Typography.tsx";

export interface DescriptionItem {
  readonly label: ReactNode;
  readonly value: ReactNode;
}

type DescriptionListProps = {
  readonly items: ReadonlyArray<DescriptionItem>;
  readonly labelWidth?: number;
  /** Put values on their own line when horizontal space must not truncate them. */
  readonly stacked?: boolean;
};

export function DescriptionList({
  items,
  labelWidth = 16,
  stacked = false,
}: DescriptionListProps) {
  return (
    <Box flexDirection="column" gap={stacked ? 1 : 0}>
      {items.map((item, index) => (
        <Box key={index} flexDirection={stacked ? "column" : "row"}>
          <Box width={stacked ? undefined : labelWidth} paddingRight={1}>
            <Text tone="muted">{item.label}</Text>
          </Box>
          <Box paddingLeft={stacked ? 1 : 0}>
            {/* Element values render bare: a Box (e.g. multi-line AnsiText
                output) cannot nest inside Text. */}
            {typeof item.value === "string" ||
            typeof item.value === "number" ? (
              <Text>{item.value}</Text>
            ) : (
              item.value
            )}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
