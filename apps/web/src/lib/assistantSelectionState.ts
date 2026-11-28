type LiveAssistantSelectionProbe = () => boolean;

const probes: LiveAssistantSelectionProbe[] = [];

export function registerAssistantSelectionProbe(probe: LiveAssistantSelectionProbe): () => void {
  probes.push(probe);
  return () => {
    const index = probes.lastIndexOf(probe);
    if (index !== -1) probes.splice(index, 1);
  };
}

/** Whether a foreground assistant selection toolbar currently has a live citeable selection. */
export function hasLiveAssistantSelection(): boolean {
  if (probes.length === 0 || typeof document === "undefined") return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  return probes.some((probe) => probe());
}
