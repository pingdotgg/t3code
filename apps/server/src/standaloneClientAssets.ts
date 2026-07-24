const EMBEDDED_CLIENT_MARKER = "standalone-client/apps/web/dist/";

declare const __T3CODE_STANDALONE_INDEX_HTML__: string | undefined;

export interface EmbeddedClientFile extends Blob {
  readonly name: string;
}

function runtimeEmbeddedFiles(): ReadonlyArray<EmbeddedClientFile> {
  return typeof Bun === "undefined"
    ? []
    : (Bun.embeddedFiles as unknown as ReadonlyArray<EmbeddedClientFile>);
}

function runtimeEmbeddedIndex(): EmbeddedClientFile | null {
  if (
    typeof __T3CODE_STANDALONE_INDEX_HTML__ === "undefined" ||
    __T3CODE_STANDALONE_INDEX_HTML__ === ""
  ) {
    return null;
  }
  const index = new Blob([__T3CODE_STANDALONE_INDEX_HTML__], {
    type: "text/html; charset=utf-8",
  });
  Object.defineProperty(index, "name", {
    value: `${EMBEDDED_CLIENT_MARKER}index.html`,
  });
  return index as EmbeddedClientFile;
}

export function resolveEmbeddedClientAsset(
  relativePath: string,
  files: ReadonlyArray<EmbeddedClientFile> = runtimeEmbeddedFiles(),
): EmbeddedClientFile | null {
  const requested = relativePath === "" ? "index.html" : relativePath;
  const exact = files.find((file) => {
    const normalizedName = file.name.replaceAll("\\", "/");
    const markerIndex = normalizedName.indexOf(EMBEDDED_CLIENT_MARKER);
    return (
      markerIndex >= 0 &&
      normalizedName.slice(markerIndex + EMBEDDED_CLIENT_MARKER.length) === requested
    );
  });
  if (exact) return exact;

  return (
    files.find((file) => {
      const normalizedName = file.name.replaceAll("\\", "/");
      return normalizedName.endsWith(`${EMBEDDED_CLIENT_MARKER}index.html`);
    }) ?? runtimeEmbeddedIndex()
  );
}
