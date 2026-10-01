// Visual reference only: https://ui.shadcn.com/docs/components/base/button
// This package owns its controls; it imports no private application component.
const controlStyle = {
  border: "1px solid currentColor",
  borderRadius: 6,
  padding: "6px 10px",
  font: "inherit",
  color: "inherit",
  background: "transparent",
  minHeight: 36,
};
const manifest = {
  id: "example.terminal-output",
  apiVersion: 1,
  version: "1.0.0",
  surfaces: [
    {
      id: "example.terminal-output/view",
      title: "Terminal output snapshot",
      scope: "thread",
      placements: ["side-panel"],
      clients: ["web", "desktop"],
      capabilities: [],
      stateVersion: 1,
    },
  ],
};
export default function createTerminalOutput(host) {
  const { createElement: h, useState, useRef, useEffect } = host.React;
  return {
    manifest,
    surfaces: [
      {
        id: manifest.id + "/view",
        validateRestore: (state) => state === null,
        createView(session) {
          return {
            renderer: function TerminalOutput() {
              const [terminalId, setTerminalId] = useState("term-1");
              const [status, setStatus] = useState("Read an existing terminal’s retained output.");
              const [contents, setContents] = useState(null);
              const pending = useRef(null);
              useEffect(() => () => pending.current?.abort(), []);
              const read = async (event) => {
                event.preventDefault();
                if (!terminalId) return;
                pending.current?.abort();
                const controller = new AbortController();
                pending.current = controller;
                const signal = AbortSignal.any([controller.signal, session.signal]);
                setContents(null);
                setStatus("Reading retained output…");
                try {
                  const result = await host.invokeApi(
                    {
                      id: "example.terminal-output/snapshot",
                      versionRange: "^1.0.0",
                      method: "readSnapshot",
                      input: { terminalId },
                      context: session.context,
                    },
                    signal,
                  );
                  if (signal.aborted) return;
                  if (result === null) {
                    setStatus("Terminal is not open.");
                    return;
                  }
                  setContents(result.contents);
                  setStatus(
                    result.truncated
                      ? "Snapshot loaded. Older retained output was omitted."
                      : "Retained output loaded. Read again to refresh.",
                  );
                } catch (error) {
                  if (!signal.aborted)
                    setStatus(
                      error instanceof Error ? error.message : "Terminal output unavailable.",
                    );
                }
              };
              return h(
                "section",
                {
                  "aria-label": "Installed terminal output snapshot",
                  style: { padding: 12, display: "grid", gap: 12, minWidth: 0 },
                },
                h(
                  "form",
                  { onSubmit: read, style: { display: "grid", gap: 12, minWidth: 0 } },
                  h(
                    "label",
                    { style: { display: "grid", gap: 6, minWidth: 0 } },
                    "Terminal ID",
                    h("input", {
                      style: {
                        ...controlStyle,
                        width: "100%",
                        minWidth: 0,
                        boxSizing: "border-box",
                      },
                      value: terminalId,
                      maxLength: 128,
                      onChange: (event) => {
                        pending.current?.abort();
                        setTerminalId(event.target.value);
                        setContents(null);
                        setStatus("Read an existing terminal’s retained output.");
                      },
                    }),
                  ),
                  h(
                    "button",
                    {
                      type: "submit",
                      disabled: !terminalId,
                      style: {
                        ...controlStyle,
                        justifySelf: "start",
                        cursor: terminalId ? "pointer" : "default",
                        opacity: terminalId ? 1 : 0.5,
                      },
                    },
                    "Read output",
                  ),
                ),
                h("p", { role: "status", style: { margin: 0, overflowWrap: "anywhere" } }, status),
                contents === null
                  ? null
                  : h(
                      "pre",
                      {
                        "aria-label": "Retained terminal output",
                        style: {
                          margin: 0,
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                          minWidth: 0,
                        },
                      },
                      contents,
                    ),
              );
            },
          };
        },
      },
    ],
  };
}
