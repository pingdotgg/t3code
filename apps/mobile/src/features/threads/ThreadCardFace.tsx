import type { ReactNode } from "react";
import { Pressable, View, type PressableProps, type ViewProps } from "react-native";

import { cn } from "../../lib/cn";

/**
 * The card face shared by the inline thread cards, like desktop's `TaskCardButton`: a filled
 * surface one step above the screen, a hairline border and a lighter top edge. The colors are
 * theme tokens built with desktop's formula (`themeCardFaceVariables` in mobileTheme.ts), so the
 * contrast is as subtle as desktop's on every theme (Dark Mono: screen 25, fill 38, sides 46, top 52).
 */
/** The face's classes, for a card that needs an animated view as its face (the pending question card). */
export const THREAD_CARD_FACE_CLASS_NAME =
  "overflow-hidden rounded-[10px] border border-card-face-border border-t-card-face-edge bg-card-face";

export function ThreadCardFace({
  className,
  ...props
}: ViewProps & { readonly className?: string | undefined }) {
  return <View {...props} className={cn(THREAD_CARD_FACE_CLASS_NAME, className)} />;
}

/** A header row (identity left, status right), the title on its own line and a muted meta line. */
export function ThreadCardContent({
  header,
  status,
  title,
  meta,
}: {
  readonly header: ReactNode;
  readonly status?: ReactNode;
  readonly title?: ReactNode;
  readonly meta?: ReactNode;
}) {
  return (
    <View className="gap-1.5 px-3 py-2.5">
      <View className="min-h-4 flex-row items-center gap-1.5">
        <View className="min-w-0 flex-1 flex-row items-center gap-1.5">{header}</View>
        {status}
      </View>
      {title}
      {meta}
    </View>
  );
}

export function ThreadCardButton({
  header,
  status,
  title,
  meta,
  ...pressableProps
}: Omit<PressableProps, "children" | "style" | "className"> &
  Parameters<typeof ThreadCardContent>[0]) {
  return (
    <Pressable {...pressableProps} className="active:bg-foreground/5">
      <ThreadCardContent header={header} status={status} title={title} meta={meta} />
    </Pressable>
  );
}
