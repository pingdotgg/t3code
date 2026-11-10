import { createContext, use, type ReactNode, type ComponentProps } from "react";
import { useThreadFind } from "./useThreadFind";
import { ThreadFindBar } from "./ThreadFindBar";
import { ChatCanvas } from "./ChatCanvas";

type Find = ReturnType<typeof useThreadFind>;
export const ThreadFindTimelineContext = createContext<Find["timelineProps"] | null>(null);
const ThreadFindBarContext = createContext<Find["barProps"] | null>(null);

export function ThreadFindCanvas({
  findOptions,
  ...canvasProps
}: ComponentProps<typeof ChatCanvas> & {
  findOptions: Parameters<typeof useThreadFind>[0];
}) {
  return (
    <ThreadFindProvider {...findOptions}>
      <ChatCanvas {...canvasProps} />
    </ThreadFindProvider>
  );
}

/** Owns search updates below the chat view so cycling does not rerender the composer and panels. */
function ThreadFindProvider({
  children,
  ...options
}: Parameters<typeof useThreadFind>[0] & { children: ReactNode }) {
  const find = useThreadFind(options);
  return (
    <ThreadFindBarContext value={find.barProps}>
      <ThreadFindTimelineContext value={find.timelineProps}>{children}</ThreadFindTimelineContext>
    </ThreadFindBarContext>
  );
}

export function ThreadFind({ onClose }: { onClose: () => void }) {
  const bar = use(ThreadFindBarContext);
  if (!bar) return null;
  return (
    <ThreadFindBar
      {...bar}
      onClose={() => {
        bar.onClose();
        onClose();
      }}
    />
  );
}
