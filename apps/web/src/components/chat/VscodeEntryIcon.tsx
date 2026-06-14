import { memo, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { getVscodeIconUrlForEntry } from "../../vscode-icons";
import { FileIcon, FolderIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import {
  getVscodeIconLoadStatus,
  markVscodeIconFailed,
  markVscodeIconLoaded,
  subscribeVscodeIconLoadStatus,
} from "../../vscode-icon-load-store";

export const VscodeEntryIcon = memo(function VscodeEntryIcon(props: {
  pathValue: string;
  kind: "file" | "directory";
  theme: "light" | "dark";
  className?: string;
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const iconUrl = useMemo(
    () => getVscodeIconUrlForEntry(props.pathValue, props.kind, props.theme),
    [props.kind, props.pathValue, props.theme],
  );
  const subscribe = useCallback(
    (listener: () => void) => subscribeVscodeIconLoadStatus(iconUrl, listener),
    [iconUrl],
  );
  const getSnapshot = useCallback(() => getVscodeIconLoadStatus(iconUrl), [iconUrl]);
  const status = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const fallback =
    props.kind === "directory" ? (
      <FolderIcon className={cn("size-4 shrink-0 text-muted-foreground/80", props.className)} />
    ) : (
      <FileIcon className={cn("size-4 shrink-0 text-muted-foreground/80", props.className)} />
    );

  useEffect(() => {
    const image = imageRef.current;
    if (status !== "loading" || !image) return;
    if (image.complete && image.naturalWidth > 0) {
      markVscodeIconLoaded(iconUrl);
    }
  }, [iconUrl, status]);

  if (status === "error") return fallback;

  return (
    <>
      {status === "loaded" ? null : fallback}
      <img
        ref={imageRef}
        src={iconUrl}
        alt=""
        aria-hidden="true"
        className={cn("size-4 shrink-0", status !== "loaded" && "hidden", props.className)}
        onLoad={() => markVscodeIconLoaded(iconUrl)}
        onError={() => markVscodeIconFailed(iconUrl)}
      />
    </>
  );
});
