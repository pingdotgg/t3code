import { createElement as h, useEffect, useRef, useState } from "react";

const capability = "t3.workspace/read-text";
/** @param {import("@t3tools/extension-sdk/contracts").Json} state */
function savedPath(state) {
  return state !== null &&
    !Array.isArray(state) &&
    typeof state === "object" &&
    Object.keys(state).length === 1 &&
    "relativePath" in state &&
    typeof state.relativePath === "string"
    ? state.relativePath
    : null;
}

/**
 * Community package: only React and public SDK exports; no native bindings or app imports.
 * @type {import("@t3tools/extension-sdk/host").Extension<import("@t3tools/extension-sdk/react").SurfaceRenderer>}
 */
export const workspaceReader = {
  manifest: {
    id: "example.workspace-reader",
    apiVersion: 1,
    version: "1.0.0",
    surfaces: [
      {
        id: "example.workspace-reader/view",
        title: "Workspace text",
        scope: "project",
        clients: ["web"],
        placements: ["side-panel", "bottom-dock"],
        capabilities: [capability],
        stateVersion: 1,
      },
    ],
  },
  surfaces: [
    {
      id: "example.workspace-reader/view",
      validateRestore: (state) => state === null || savedPath(state) !== null,
      createView(session) {
        return {
          renderer: function WorkspaceReader() {
            const [path, setPath] = useState(savedPath(session.restoreState) ?? "README.md");
            const [contents, setContents] = useState("");
            const [status, setStatus] = useState("Choose a workspace file");
            const request = useRef(0);
            useEffect(() => {
              const stop = session.onVisibility((visible) => {
                request.current++;
                if (visible) setStatus("Ready to read");
              });
              return () => {
                request.current++;
                stop();
              };
            }, []);
            async function read() {
              const current = ++request.current;
              session.save({ relativePath: path });
              setContents("");
              setStatus("Reading");
              try {
                const value = await session.invoke(capability, { relativePath: path });
                if (current !== request.current || session.signal.aborted || !session.visible)
                  return;
                if (
                  !value ||
                  typeof value !== "object" ||
                  Array.isArray(value) ||
                  !("contents" in value) ||
                  !("truncated" in value) ||
                  typeof value.contents !== "string" ||
                  typeof value.truncated !== "boolean"
                )
                  throw new Error("Invalid workspace text response");
                setContents(value.contents);
                setStatus(value.truncated ? "Read complete (truncated)" : "Read complete");
              } catch (error) {
                if (current === request.current && !session.signal.aborted && session.visible)
                  setStatus(error instanceof Error ? error.message : "Read failed");
              }
            }
            return h(
              "section",
              { "aria-label": "Workspace text reader" },
              h(
                "label",
                null,
                "Workspace-relative path",
                h("input", {
                  value: path,
                  onChange: (event) => {
                    request.current++;
                    setPath(event.target.value);
                    setContents("");
                    setStatus("Ready to read");
                  },
                }),
              ),
              h("button", { onClick: () => void read() }, "Read file"),
              h("p", { role: "status" }, status),
              h("pre", null, contents),
            );
          },
        };
      },
    },
  ],
};
