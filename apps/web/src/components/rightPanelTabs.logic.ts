interface ScrollableTab {
  scrollIntoView: (options: ScrollIntoViewOptions) => void;
}

export function scrollActiveRightPanelTabIntoView(
  activeTab: ScrollableTab | null,
  tabDragActive: boolean,
): void {
  if (tabDragActive) return;
  activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
