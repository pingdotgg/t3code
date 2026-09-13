/** @jsxImportSource react */
import { AnsiText } from "@alchemy.run/sigil";
import { inspect } from "node:util";
import type { ReactNode } from "react";
import { Box, useCliEnvironment } from "../ui/index.ts";

export interface StackOutputsProps {
  readonly value: unknown;
  readonly offset?: number;
  readonly limit?: number;
}

export function StackOutputs({
  value,
  offset = 0,
  limit = Number.POSITIVE_INFINITY,
}: StackOutputsProps) {
  const { colors } = useCliEnvironment();
  const output = inspect(value, { colors });
  const lines = output.split("\n").slice(offset, offset + limit);

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <AnsiText key={offset + index} wrap="none">
          {line || " "}
        </AnsiText>
      ))}
    </Box>
  );
}

export const stackOutputLineCount = (value: unknown): number =>
  inspect(value, { colors: false }).split("\n").length;

export const stackOutputsView = (value: unknown): ReactNode => (
  <StackOutputs value={value} />
);
