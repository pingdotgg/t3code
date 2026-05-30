import { Platform, Text as NativeText, View } from "react-native";

import { cn } from "../../lib/cn";

import type { ReviewRenderableLineRow } from "./reviewModel";
import type { ReviewHighlightedToken } from "./shikiReviewHighlighter";

export const REVIEW_MONO_FONT_FAMILY = Platform.select({
  ios: "ui-monospace",
  android: "monospace",
  default: "monospace",
});

export const REVIEW_DIFF_LINE_HEIGHT = 26;
const REVIEW_DELETE_STRIPE_COUNT = REVIEW_DIFF_LINE_HEIGHT / 2;

export function renderVisibleWhitespace(value: string): string {
  const expandedTabs = value.replace(/\t/g, "    ");
  return expandedTabs.replace(/^( +)/, (leading) => leading.replaceAll(" ", "\u00A0"));
}

export function changeTone(change: ReviewRenderableLineRow["change"]): string {
  if (change === "add") return "bg-emerald-500/10";
  if (change === "delete") return "bg-rose-500/10";
  return "bg-card";
}

export function changeBarTone(change: ReviewRenderableLineRow["change"]): string {
  if (change === "add") return "bg-emerald-400";
  if (change === "delete") return "bg-rose-400";
  return "bg-border/50";
}

function diffHighlightColor(change: ReviewRenderableLineRow["change"]): string | undefined {
  if (change === "add") return "rgba(16, 185, 129, 0.24)";
  if (change === "delete") return "rgba(244, 63, 94, 0.24)";
  return undefined;
}

export function ReviewChangeBar(props: { readonly change: ReviewRenderableLineRow["change"] }) {
  if (props.change === "delete") {
    return (
      <View className="w-[5px] overflow-hidden" style={{ height: REVIEW_DIFF_LINE_HEIGHT }}>
        <View>
          {Array.from({ length: REVIEW_DELETE_STRIPE_COUNT }, (_, index) => (
            <View key={index}>
              <View className="w-[5px] bg-rose-400" style={{ height: 1 }} />
              <View style={{ height: 1 }} />
            </View>
          ))}
        </View>
      </View>
    );
  }

  return (
    <View className="w-[5px] overflow-hidden" style={{ height: REVIEW_DIFF_LINE_HEIGHT }}>
      <View className={cn("h-full w-[5px] flex-1", changeBarTone(props.change))} />
    </View>
  );
}

export function DiffTokenText(props: {
  readonly tokens: ReadonlyArray<ReviewHighlightedToken> | null;
  readonly fallback: string;
  readonly change?: ReviewRenderableLineRow["change"];
  readonly className?: string;
}) {
  if (!props.tokens || props.tokens.length === 0) {
    return (
      <NativeText
        numberOfLines={1}
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
      numberOfLines={1}
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
                backgroundColor:
                  token.diffHighlight && props.change
                    ? diffHighlightColor(props.change)
                    : undefined,
                borderRadius: token.diffHighlight ? 4 : undefined,
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
