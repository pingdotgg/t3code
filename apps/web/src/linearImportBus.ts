const LINEAR_IMPORT_OPEN_EVENT = "t3code:open-linear-import";

export function openLinearImport(): void {
  window.dispatchEvent(new CustomEvent(LINEAR_IMPORT_OPEN_EVENT));
}

export function onOpenLinearImport(listener: () => void): () => void {
  const handler = () => {
    listener();
  };
  window.addEventListener(LINEAR_IMPORT_OPEN_EVENT, handler);
  return () => window.removeEventListener(LINEAR_IMPORT_OPEN_EVENT, handler);
}
