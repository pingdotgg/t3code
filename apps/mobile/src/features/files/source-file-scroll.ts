import type { FlatList } from "react-native";

/** Owns the initial scroll and retries for one requested source line. */
export function createSourceFileScrollRequest(
  list: Pick<FlatList<string>, "scrollToIndex" | "scrollToOffset">,
  index: number,
) {
  let disposed = false;
  let retryCount = 0;
  let frame: number | null = null;

  const scheduleScroll = () => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
    }
    frame = requestAnimationFrame(() => {
      frame = null;
      if (!disposed) {
        list.scrollToIndex({ index, animated: false, viewPosition: 0.3 });
      }
    });
  };

  scheduleScroll();

  return {
    retry(info: { index: number; averageItemLength: number }, rowHeight: number) {
      if (disposed || info.index !== index || retryCount >= 5) {
        return;
      }
      retryCount += 1;
      const itemLength = info.averageItemLength > 0 ? info.averageItemLength : rowHeight;
      list.scrollToOffset({ offset: index * itemLength, animated: false });
      scheduleScroll();
    },
    dispose() {
      disposed = true;
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    },
  };
}
