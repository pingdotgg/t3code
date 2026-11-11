// Keydown handlers read this on every key, so a mount count replaces a document query.
let mountedModelPickers = 0;

export function registerModelPickerContent(): () => void {
  mountedModelPickers += 1;
  return () => {
    mountedModelPickers -= 1;
  };
}

export function isModelPickerOpen(): boolean {
  return mountedModelPickers > 0;
}
