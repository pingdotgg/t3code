const manifest = {
  id: "example.files",
  apiVersion: 1,
  version: "1.0.1",
  surfaces: [
    {
      id: "example.files/view",
      title: "Files (public APIs)",
      scope: "project",
      placements: ["side-panel"],
      clients: ["web", "desktop"],
      capabilities: [],
      stateVersion: 1,
    },
  ],
};

// Portable inline styles use host color tokens when present; no private components or CSS build step.
const border = "1px solid var(--border, #dfe3e8)";
const muted = "var(--muted-foreground, #667085)";
const buttonStyle = {
  font: "inherit",
  fontSize: 12,
  color: "var(--foreground, #20252d)",
  background: "var(--background, #fff)",
  border,
  borderRadius: 6,
  padding: "5px 9px",
  minHeight: 30,
  cursor: "pointer",
  outlineOffset: 2,
};
const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 280,
    minWidth: 0,
    overflow: "hidden",
    color: "var(--foreground, #20252d)",
    background: "var(--background, #fff)",
    fontFamily: "var(--font-sans, system-ui, sans-serif)",
    fontSize: 13,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "12px 14px",
    borderBottom: border,
    flexShrink: 0,
  },
  title: { margin: 0, fontSize: 14, fontWeight: 600 },
  badge: { fontSize: 11, color: muted, border, borderRadius: 5, padding: "2px 5px" },
  body: {
    display: "grid",
    gridTemplateColumns: "minmax(125px, 35%) minmax(0, 1fr)",
    flex: 1,
    minHeight: 0,
  },
  explorer: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    borderRight: border,
    background: "var(--muted, #f8fafc)",
  },
  directory: {
    padding: "10px 12px",
    fontSize: 11,
    color: muted,
    borderBottom: border,
    overflowWrap: "anywhere",
  },
  list: { listStyle: "none", margin: 0, padding: 6, overflow: "auto", minHeight: 0, flex: 1 },
  fileButton: {
    ...buttonStyle,
    display: "block",
    width: "100%",
    textAlign: "left",
    border: "1px solid transparent",
    background: "transparent",
    borderRadius: 5,
    padding: "6px 8px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  viewer: { display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 },
  fileTitle: {
    margin: 0,
    padding: "10px 14px",
    fontSize: 12,
    fontWeight: 500,
    borderBottom: border,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  contents: {
    margin: 0,
    padding: "14px 16px",
    minHeight: 0,
    flex: 1,
    overflow: "auto",
    fontSize: 12,
    lineHeight: 1.7,
    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)",
    tabSize: 2,
  },
  status: {
    margin: 0,
    padding: "8px 14px",
    borderTop: border,
    color: muted,
    fontSize: 11,
    flexShrink: 0,
  },
};

/** @type {import("@t3tools/extension-sdk/environment").ClientFactory} */
export default function createFiles(host) {
  const { createElement: h, useEffect, useState } = host.React;
  return {
    manifest,
    surfaces: [
      {
        id: manifest.id + "/view",
        validateRestore(state) {
          return (
            state === null ||
            (!!state &&
              typeof state === "object" &&
              !Array.isArray(state) &&
              Object.keys(state).length === 1 &&
              typeof state.relativePath === "string" &&
              state.relativePath.length <= 512)
          );
        },
        createView(session) {
          return {
            renderer: function Files() {
              const [path, setPath] = useState(session.restoreState?.relativePath ?? "");
              const [directory, setDirectory] = useState("");
              const [entries, setEntries] = useState([]);
              const [cursor, setCursor] = useState(null);
              const [page, setPage] = useState(null);
              const navigate = (next) => {
                setPage(null);
                setDirectory(next);
              };
              const [contents, setContents] = useState("");
              const [status, setStatus] = useState("Choose a file to preview");
              const [listingStatus, setListingStatus] = useState("Loading files");
              const [revision, refresh] = useState(0);
              const [visible, setVisible] = useState(session.visible);
              useEffect(() => session.onVisibility(setVisible), []);
              useEffect(() => {
                if (!visible) return;
                const controller = new AbortController();
                const signal = AbortSignal.any([controller.signal, session.signal]);
                setListingStatus("Loading files");
                if (!page) setEntries([]);
                setCursor(null);
                host
                  .invokeApi(
                    {
                      id: "t3.workspace/files",
                      versionRange: "^1.0.0",
                      method: "listEntries",
                      input: {
                        relativePath: directory,
                        limit: 100,
                        ...(page ? { cursor: page } : {}),
                      },
                      context: session.context,
                    },
                    signal,
                  )
                  .then(
                    (value) => {
                      if (signal.aborted) return;
                      setEntries((previous) =>
                        page
                          ? [
                              ...new Map(
                                [...previous, ...value.entries].map((entry) => [
                                  entry.relativePath,
                                  entry,
                                ]),
                              ).values(),
                            ]
                          : value.entries,
                      );
                      setCursor(value.nextCursor);
                      setListingStatus("Files ready");
                    },
                    (error) => {
                      if (!signal.aborted) setListingStatus(error.message);
                    },
                  );
                return () => controller.abort();
              }, [directory, revision, visible, page]);
              useEffect(() => {
                setContents("");
                if (!path || !visible) return;
                const controller = new AbortController();
                const signal = AbortSignal.any([controller.signal, session.signal]);
                session.save({ relativePath: path });
                setStatus("Reading file");
                host
                  .invokeApi(
                    {
                      id: "t3.workspace/files",
                      versionRange: "^1.0.0",
                      method: "readText",
                      input: { relativePath: path },
                      context: session.context,
                    },
                    signal,
                  )
                  .then(
                    (value) => {
                      if (signal.aborted) return;
                      setContents(value.contents);
                      setStatus(
                        value.truncated ? "File truncated (read only)" : "File loaded (read only)",
                      );
                    },
                    (error) => {
                      if (!signal.aborted) setStatus(error.message);
                    },
                  );
                return () => controller.abort();
              }, [path, revision, visible]);
              return h(
                "section",
                { "aria-label": "Installed Files public API replacement", style: styles.root },
                h(
                  "header",
                  { style: styles.header },
                  h("h2", { style: styles.title }, "Files"),
                  h("span", { style: styles.badge }, "Read only"),
                  h(
                    "button",
                    {
                      style: { ...buttonStyle, marginLeft: "auto" },
                      onClick: () => {
                        setPage(null);
                        refresh((value) => value + 1);
                      },
                    },
                    "Refresh files",
                  ),
                ),
                h(
                  "div",
                  { style: styles.body },
                  h(
                    "nav",
                    { "aria-label": "Workspace files", style: styles.explorer },
                    h("div", { style: styles.directory }, directory || "Workspace root"),
                    directory
                      ? h(
                          "button",
                          {
                            style: { ...buttonStyle, margin: "6px 6px 0" },
                            onClick: () => navigate(directory.split("/").slice(0, -1).join("/")),
                          },
                          "Parent directory",
                        )
                      : null,
                    h(
                      "ul",
                      { style: styles.list },
                      ...entries.map((entry) =>
                        h(
                          "li",
                          { key: entry.relativePath },
                          h(
                            "button",
                            {
                              title: entry.relativePath,
                              style: {
                                ...styles.fileButton,
                                ...(entry.relativePath === path
                                  ? {
                                      background: "var(--accent, #e8eef7)",
                                      borderColor: "var(--border, #dfe3e8)",
                                      fontWeight: 600,
                                    }
                                  : {}),
                              },
                              onClick: () =>
                                entry.kind === "directory"
                                  ? navigate(entry.relativePath)
                                  : setPath(entry.relativePath),
                              "aria-current": entry.relativePath === path ? "true" : undefined,
                            },
                            entry.name + (entry.kind === "directory" ? "/" : ""),
                          ),
                        ),
                      ),
                    ),
                    cursor
                      ? h(
                          "button",
                          { style: { ...buttonStyle, margin: 6 }, onClick: () => setPage(cursor) },
                          "Load more entries",
                        )
                      : null,
                    h("p", { style: { ...styles.status, padding: "7px 12px" } }, listingStatus),
                  ),
                  h(
                    "div",
                    { style: styles.viewer },
                    h("h3", { style: styles.fileTitle, title: path }, path || "File preview"),
                    h("pre", { "aria-label": "File contents", style: styles.contents }, contents),
                    !path
                      ? h(
                          "p",
                          { style: { margin: 0, padding: 16, color: muted } },
                          "Choose a file from the workspace.",
                        )
                      : null,
                  ),
                ),
                h("p", { role: "status", style: styles.status }, status),
              );
            },
          };
        },
      },
    ],
  };
}
