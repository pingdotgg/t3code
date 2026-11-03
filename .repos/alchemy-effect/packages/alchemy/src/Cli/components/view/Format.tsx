/** @jsxRuntime automatic */
/** @jsxImportSource @alchemy.run/sigil */
import { stripVTControlCharacters } from "node:util";
import { renderToString } from "@alchemy.run/sigil";
import type { RenderOptions, TerminalCapabilities, View } from "../types.ts";
import { CliEnvironment } from "../ui/Environment.tsx";
import { Text } from "../ui/Typography.tsx";

export const normalizeView = (view: View): View => {
  if (typeof view === "string" || typeof view === "number" || typeof view === "bigint") {
    return <Text>{String(view)}</Text>;
  }
  // Contract: an array of primitives renders as ONE Text line with the
  // elements concatenated (no separator) — matching how React renders
  // adjacent text children. Callers wanting separators must join themselves.
  if (
    Array.isArray(view) &&
    view.every(
      (item) =>
        item === null ||
        item === undefined ||
        typeof item === "boolean" ||
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "bigint",
    )
  ) {
    return (
      <Text>
        {view
          .filter((item) => item !== null && item !== undefined && typeof item !== "boolean")
          .map(String)
          .join("")}
      </Text>
    );
  }
  return view;
};

/** Render a layout to a string without a live renderer (help, plain output, snapshots). */
export const formatView = (
  view: View,
  capabilities: TerminalCapabilities,
  options: RenderOptions = {},
): string => {
  const colors = options.colors ?? capabilities.colors;
  // The renderer and the components must agree on the width: components size
  // themselves from the environment's `columns`, so an explicit render width
  // has to flow into the capabilities too, not only into renderToString.
  const columns = options.columns ?? capabilities.columns;
  const output = renderToString(
    <CliEnvironment capabilities={{ ...capabilities, colors, columns }}>
      {normalizeView(view)}
    </CliEnvironment>,
    { columns, colorProfile: colors ? "truecolor" : "none" },
  ).replace(/[\s\n]+$/, "");
  return colors ? output : stripVTControlCharacters(output);
};
