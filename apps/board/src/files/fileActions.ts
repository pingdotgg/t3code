export const actionClass =
  "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted enabled:hover:bg-hover enabled:hover:text-fg disabled:opacity-50";

export const buttonClass =
  "h-6 rounded-md border border-line px-2 text-[11px] text-fg enabled:hover:bg-hover disabled:opacity-50";

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
