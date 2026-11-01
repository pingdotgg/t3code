/** The loader owns deduplication and the shared request cap, including other tree loads. */
export async function loadFileAncestors(
  selectedPath: string,
  load: (directoryPath: string) => Promise<void>,
  options: { readonly signal: AbortSignal },
) {
  const segments = selectedPath.split("/");
  let next = 0;
  const worker = async () => {
    while (next < segments.length && !options.signal.aborted) {
      await load(segments.slice(0, next++).join("/"));
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, segments.length) }, worker));
}
