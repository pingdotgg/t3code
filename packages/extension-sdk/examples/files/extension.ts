import { defineExtension, requireApi } from "@t3tools/extension-sdk/authoring";
import { filePresentationApi, workspaceFilesApi } from "@t3tools/extension-sdk/catalogue";
import { bindApi } from "@t3tools/extension-sdk/capabilities";
import type { WorkspaceListEntriesResult } from "@t3tools/extension-sdk/catalogue";
import type { WorkspaceReadTextResult } from "@t3tools/extension-sdk/workspace";
import { infoApi } from "./api.js";

const border = "1px solid var(--border, #dfe3e8)";
const muted = "var(--muted-foreground, #667085)";
const button = {
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
  file: {
    ...button,
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

function restoreState(state: unknown) {
  if (state === null) return true;
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const value = state as { readonly relativePath?: unknown };
  return (
    Object.keys(value).length === 1 &&
    typeof value.relativePath === "string" &&
    value.relativePath.length <= 512
  );
}

function restoredPath(state: unknown) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return "";
  const value = state as { readonly relativePath?: unknown };
  return typeof value.relativePath === "string" ? value.relativePath : "";
}

export default defineExtension({
  id: "example.files",
  version: "1.0.2",
  provides: [filePresentationApi.definition, infoApi.definition],
  requires: [requireApi(workspaceFilesApi)],
  serverEntry: "server.ts",
  surfaces: [
    {
      name: "view",
      title: "Files (public APIs)",
      scope: "project",
      placements: ["side-panel"],
      clients: ["web", "desktop"],
      stateVersion: 1,
      validateRestore: restoreState,
      createView(host, session) {
        const { createElement: h, useEffect, useState } = host.React;
        return {
          renderer: function Files() {
            const [path, setPath] = useState(restoredPath(session.restoreState));
            const [directory, setDirectory] = useState("");
            const [entries, setEntries] = useState<
              readonly { name: string; relativePath: string; kind: "file" | "directory" }[]
            >([]);
            const [cursor, setCursor] = useState<string | null>(null);
            const [page, setPage] = useState<string | null>(null);
            const [contents, setContents] = useState("");
            const [status, setStatus] = useState("Choose a file to preview");
            const [listingStatus, setListingStatus] = useState("Loading files");
            const [revision, refresh] = useState(0);
            const [visible, setVisible] = useState(session.visible);
            const navigate = (next: string) => {
              setPage(null);
              setDirectory(next);
            };
            useEffect(() => session.onVisibility(setVisible), [session]);
            useEffect(() => {
              if (!visible) return;
              const controller = new AbortController();
              const signal = AbortSignal.any([controller.signal, session.signal]);
              const api = bindApi(workspaceFilesApi, host, session.context);
              setListingStatus("Loading files");
              if (!page) setEntries([]);
              setCursor(null);
              void api
                .invoke(
                  "listEntries",
                  { relativePath: directory, limit: 100, ...(page ? { cursor: page } : {}) },
                  signal,
                )
                .then(
                  (value: WorkspaceListEntriesResult) => {
                    if (signal.aborted) return;
                    setEntries((previous: typeof entries) =>
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
                    if (!signal.aborted)
                      setListingStatus(
                        error instanceof Error ? error.message : "Files unavailable",
                      );
                  },
                );
              return () => controller.abort();
            }, [directory, revision, visible, page, host, session]);
            useEffect(() => {
              setContents("");
              if (!path || !visible) return;
              const controller = new AbortController();
              const signal = AbortSignal.any([controller.signal, session.signal]);
              const api = bindApi(workspaceFilesApi, host, session.context);
              session.save({ relativePath: path });
              setStatus("Reading file");
              void api.invoke("readText", { relativePath: path }, signal).then(
                (value: WorkspaceReadTextResult) => {
                  if (signal.aborted) return;
                  setContents(value.contents);
                  setStatus(
                    value.truncated ? "File truncated (read only)" : "File loaded (read only)",
                  );
                },
                (error) => {
                  if (!signal.aborted)
                    setStatus(error instanceof Error ? error.message : "File unavailable");
                },
              );
              return () => controller.abort();
            }, [path, revision, visible, host, session]);
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
                    style: { ...button, marginLeft: "auto" },
                    onClick: () => {
                      setPage(null);
                      refresh((value: number) => value + 1);
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
                          style: { ...button, margin: "6px 6px 0" },
                          onClick: () => navigate(directory.split("/").slice(0, -1).join("/")),
                        },
                        "Parent directory",
                      )
                    : null,
                  h(
                    "ul",
                    { style: styles.list },
                    ...entries.map((entry: (typeof entries)[number]) =>
                      h(
                        "li",
                        { key: entry.relativePath },
                        h(
                          "button",
                          {
                            title: entry.relativePath,
                            style: {
                              ...styles.file,
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
                        { style: { ...button, margin: 6 }, onClick: () => setPage(cursor) },
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
});
