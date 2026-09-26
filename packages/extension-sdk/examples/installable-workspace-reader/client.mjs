/** @type {import("@t3tools/extension-sdk/environment").ClientFactory} */
export default function createReader(host) {
  const { createElement: h, useState, useEffect } = host.React;
  /** @type {Map<string, {title:string,text:string}>} */
  const latest = new Map();
  /** @param {import("@t3tools/extension-sdk/contracts").ViewContext} context */
  const key = (context) =>
    JSON.stringify([
      context.resource.environmentId,
      context.resource.projectId,
      context.resource.threadId,
      context.workspaceRevision,
    ]);
  /** @param {string} text */
  function contextText(text) {
    let result = "";
    let bytes = 0;
    for (const character of text) {
      const next = new TextEncoder().encode(character).length;
      if (bytes + next > 8000) return result + "\n[Context truncated]";
      bytes += next;
      result += character;
    }
    return result || "(Empty file)";
  }
  return {
    manifest: {
      id: "example.installed-reader",
      apiVersion: 1,
      version: "1.0.0",
      surfaces: [
        {
          id: "example.installed-reader/view",
          title: "Workspace reader",
          scope: "project",
          placements: ["side-panel", "bottom-dock"],
          clients: ["web", "desktop"],
          capabilities: [],
          stateVersion: 1,
        },
      ],
      composerContexts: [
        {
          id: "example.installed-reader/selection",
          title: "Selected workspace text",
          clients: ["web", "desktop"],
        },
      ],
    },
    composerContexts: [
      {
        id: "example.installed-reader/selection",
        select(context) {
          const selected = latest.get(key(context));
          if (!selected)
            throw new Error("Read a workspace file in this project before selecting context");
          return { ...selected };
        },
      },
    ],
    surfaces: [
      {
        id: "example.installed-reader/view",
        validateRestore(state) {
          return (
            state === null ||
            (typeof state === "object" &&
              !Array.isArray(state) &&
              Object.keys(state).length === 1 &&
              "relativePath" in state &&
              typeof state.relativePath === "string" &&
              state.relativePath.length <= 1024)
          );
        },
        createView(session) {
          /** @type {AbortController | undefined} */
          let pending;
          let sequence = 0;
          const cancel = () => {
            sequence++;
            pending?.abort();
            pending = undefined;
          };
          session.onDispose(cancel);
          session.onVisibility((visible) => {
            if (!visible) cancel();
          });
          const saved = session.restoreState;
          const initialPath =
            saved &&
            typeof saved === "object" &&
            !Array.isArray(saved) &&
            "relativePath" in saved &&
            typeof saved.relativePath === "string"
              ? saved.relativePath
              : "README.md";
          return {
            renderer: function Reader() {
              const [path, setPath] = useState(initialPath);
              const [contents, setContents] = useState("");
              const [status, setStatus] = useState("Choose a workspace file");
              useEffect(() => {
                const stop = session.onVisibility((visible) => {
                  if (visible) setStatus("Ready to read");
                });
                return () => {
                  stop();
                  cancel();
                };
              }, []);
              async function read() {
                cancel();
                if (!session.visible || session.signal.aborted) return;
                session.save({ relativePath: path });
                const current = sequence;
                const controller = new AbortController();
                pending = controller;
                setContents("");
                setStatus("Reading");
                try {
                  const value = await host.invokeTool(
                    "example.installed-reader/read",
                    { relativePath: path },
                    session.context,
                    controller.signal,
                  );
                  if (
                    current !== sequence ||
                    controller.signal.aborted ||
                    session.signal.aborted ||
                    !session.visible
                  )
                    return;
                  if (
                    !value ||
                    typeof value !== "object" ||
                    Array.isArray(value) ||
                    !("relativePath" in value) ||
                    !("contents" in value) ||
                    !("byteLength" in value) ||
                    !("truncated" in value) ||
                    value.relativePath !== path ||
                    typeof value.contents !== "string" ||
                    typeof value.byteLength !== "number" ||
                    !Number.isSafeInteger(value.byteLength) ||
                    value.byteLength < 0 ||
                    typeof value.truncated !== "boolean" ||
                    new TextEncoder().encode(JSON.stringify(value)).length > 65536
                  )
                    throw new Error("Invalid workspace text result");
                  latest.delete(key(session.context));
                  if (latest.size >= 16) latest.delete(latest.keys().next().value ?? "");
                  latest.set(key(session.context), {
                    title: path.slice(0, 200),
                    text: contextText(value.contents),
                  });
                  setContents(value.contents);
                  setStatus(value.truncated ? "Read complete (truncated)" : "Read complete");
                } catch (error) {
                  if (
                    current === sequence &&
                    !controller.signal.aborted &&
                    !session.signal.aborted &&
                    session.visible
                  )
                    setStatus(error instanceof Error ? error.message : "Read failed");
                } finally {
                  if (pending === controller) pending = undefined;
                }
              }
              return h(
                "section",
                { "aria-label": "Installed workspace reader" },
                h(
                  "label",
                  null,
                  "Workspace-relative path",
                  h("input", {
                    value: path,
                    maxLength: 1024,
                    onChange: (
                      /** @type {import("react").ChangeEvent<HTMLInputElement>} */ event,
                    ) => {
                      cancel();
                      setPath(event.target.value);
                      setContents("");
                      setStatus("Ready to read");
                    },
                  }),
                ),
                h("button", { onClick: read }, "Read file"),
                h("p", { role: "status" }, status),
                h("pre", null, contents),
              );
            },
          };
        },
      },
    ],
  };
}
