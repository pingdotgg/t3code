import { Platform, Text as NativeText } from "react-native";

import { cn } from "../../../lib/cn";

import type { ReviewRenderableLineRow } from "./reviewModel";
import type { ReviewHighlightedToken } from "./shikiReviewHighlighter";

export const REVIEW_MONO_FONT_FAMILY = Platform.select({
  ios: "ui-monospace",
  android: "monospace",
  default: "monospace",
});

export function renderVisibleWhitespace(value: string): string {
  const expandedTabs = value.replace(/\t/g, "    ");
  return expandedTabs.replace(/^( +)/, (leading) => leading.replaceAll(" ", "\u00A0"));
}

export function changeTone(change: ReviewRenderableLineRow["change"]): string {
  if (change === "add") return "bg-emerald-500/12";
  if (change === "delete") return "bg-rose-500/12";
  return "bg-card";
}

export function DiffTokenText(props: {
  readonly tokens: ReadonlyArray<ReviewHighlightedToken> | null;
  readonly fallback: string;
  readonly className?: string;
}) {
  if (!props.tokens || props.tokens.length === 0) {
    return (
      <NativeText
        selectable
        className={cn("text-[13px] leading-[17px] font-medium text-foreground", props.className)}
        style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}
      >
        {renderVisibleWhitespace(props.fallback || " ")}
      </NativeText>
    );
  }

  return (
    <NativeText
      selectable
      className={cn("text-[13px] leading-[17px] font-medium text-foreground", props.className)}
      style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}
    >
      {(() => {
        let offset = 0;

        return props.tokens.map((token) => {
          const start = offset;
          offset += token.content.length;

          const fontWeight =
            token.fontStyle !== null && (token.fontStyle & 2) === 2
              ? ("700" as const)
              : ("500" as const);
          const fontStyle =
            token.fontStyle !== null && (token.fontStyle & 1) === 1
              ? ("italic" as const)
              : ("normal" as const);

          return (
            <NativeText
              key={`${start}:${token.content.length}:${token.color ?? ""}:${token.fontStyle ?? ""}`}
              selectable
              style={{
                color: token.color ?? undefined,
                fontFamily: REVIEW_MONO_FONT_FAMILY,
                fontWeight,
                fontStyle,
              }}
            >
              {token.content.length > 0 ? renderVisibleWhitespace(token.content) : " "}
            </NativeText>
          );
        });
      })()}
    </NativeText>
  );
}
