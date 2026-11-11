// Keydown handlers read this on every key, so a mount count replaces a document query.
let mountedModelPickers = 0;
const listeners = new Set<() => void>();

function setMountedModelPickers(next: number) {
  const wasOpen = mountedModelPickers > 0;
  mountedModelPickers = next;
  if (wasOpen === mountedModelPickers > 0) return;
  for (const listener of listeners) listener();
}

export function registerModelPickerContent(): () => void {
  setMountedModelPickers(mountedModelPickers + 1);
  return () => {
    setMountedModelPickers(mountedModelPickers - 1);
  };
}

export function isModelPickerOpen(): boolean {
  return mountedModelPickers > 0;
}

export function subscribeToModelPickerVisibility(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
