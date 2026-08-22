export const CHAT_LIST_ANCHOR_OFFSET = 16;

export interface ChatListAnchoredEndSpace {
  readonly anchorIndex: number;
  readonly anchorOffset: number;
}

export interface ChatListAnchorOptions {
  readonly anchorOffset?: number;
}

export function resolveChatListAnchoredEndSpace<Item, AnchorId>(
  items: ReadonlyArray<Item>,
  anchorId: AnchorId | null,
  getAnchorId: (item: Item) => AnchorId | null,
  options: ChatListAnchorOptions = {},
): ChatListAnchoredEndSpace | undefined {
  if (anchorId === null) {
    return undefined;
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) {
      continue;
    }

    const itemAnchorId = getAnchorId(item);
    if (itemAnchorId === null) {
      continue;
    }

    return itemAnchorId === anchorId
      ? {
          anchorIndex: index,
          anchorOffset: options.anchorOffset ?? CHAT_LIST_ANCHOR_OFFSET,
        }
      : undefined;
  }

  return undefined;
}
