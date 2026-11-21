import { useClientSettings } from "../hooks/useSettings";
import { type FileLinkPathMeta, fileLinkPathPrefix } from "./fileLinkPathDepth";

export function useFileLinkPrefix(parentSuffixByPath: ReadonlyMap<string, string>) {
  const depth = useClientSettings((settings) => settings.fileLinkPathDepth);
  return (meta: FileLinkPathMeta) => fileLinkPathPrefix(meta, parentSuffixByPath, depth);
}

/** A file link's folders before its name; rtl outside so a long prefix loses its start, not its `/`. */
export function FileLinkPathPrefix({ prefix }: { prefix: string | undefined }) {
  if (prefix === undefined) return null;
  // Not a percentage: the chip's width includes the uncapped prefix, so a percentage cuts a
  // prefix that fits. cqi is the user row's width there and the viewport's elsewhere.
  return (
    <span
      data-thread-find-decoration=""
      className="inline-block max-w-[min(30cqi,12em)] overflow-x-clip text-ellipsis whitespace-nowrap text-muted-foreground [direction:rtl]"
    >
      <span dir="ltr">{prefix}</span>
    </span>
  );
}
