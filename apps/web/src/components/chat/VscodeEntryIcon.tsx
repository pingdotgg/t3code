import { memo, useMemo, useReducer } from "react";
import { getVscodeIconUrlForEntry } from "../../vscode-icons";
import { FileIcon, FolderIcon } from "lucide-react";
import { cn } from "~/lib/utils";

const failedIconUrls = new Set<string>();
const loadedIconUrls = new Set<string>();

export const VscodeEntryIcon = memo(function VscodeEntryIcon(props: {
  pathValue: string;
  kind: "file" | "directory";
  theme: "light" | "dark";
  className?: string;
}) {
  const [, forceRender] = useReducer((tick: number) => tick + 1, 0);
  const iconUrl = useMemo(
    () => getVscodeIconUrlForEntry(props.pathValue, props.kind, props.theme),
    [props.kind, props.pathValue, props.theme],
  );
  const failed = failedIconUrls.has(iconUrl);
  const loaded = loadedIconUrls.has(iconUrl);

  const fallback =
    props.kind === "directory" ? (
      <FolderIcon className={cn("size-4 shrink-0 text-muted-foreground/80", props.className)} />
    ) : (
      <FileIcon className={cn("size-4 shrink-0 text-muted-foreground/80", props.className)} />
    );

  if (failed) return fallback;

  return (
    <>
      {loaded ? null : fallback}
      <img
        src={iconUrl}
        alt=""
        aria-hidden="true"
        className={cn("size-4 shrink-0", !loaded && "hidden", props.className)}
        onLoad={() => {
          if (!loadedIconUrls.has(iconUrl)) {
            loadedIconUrls.add(iconUrl);
            forceRender();
          }
        }}
        onError={() => {
          failedIconUrls.add(iconUrl);
          forceRender();
        }}
      />
    </>
  );
});
