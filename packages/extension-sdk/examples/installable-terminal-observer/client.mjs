// Visual reference only: https://ui.shadcn.com/docs/components/base/button
// Own semantic controls keep the package independent of private app components.
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
  id: "example.terminal-observer",
  apiVersion: 1,
  version: "1.0.0",
  surfaces: [
    {
      id: "example.terminal-observer/view",
      title: "Terminal status",
      scope: "thread",
      placements: ["side-panel"],
      clients: ["web", "desktop"],
      capabilities: [],
      stateVersion: 1,
    },
  ],
};

/** This independently installable view uses only the host's public API contract. */
export default function createTerminalObserver(host) {
  const { createElement: h, useState, useRef, useEffect } = host.React;
  return {
    manifest,
    surfaces: [
      {
        id: manifest.id + "/view",
        validateRestore: (state) => state === null,
        createView(session) {
          return {
            renderer: function TerminalObserver() {
              const [terminalId, setTerminalId] = useState("term-1");
              const [status, setStatus] = useState("Choose an existing terminal.");
              const pending = useRef(null);
              useEffect(() => () => pending.current?.abort(), []);
              const inspect = async () => {
                pending.current?.abort();
                const controller = new AbortController();
                pending.current = controller;
                const signal = AbortSignal.any([controller.signal, session.signal]);
                setStatus("Reading terminal status…");
                try {
                  const result = await host.invokeApi(
                    {
                      id: "example.terminal-observer/status",
                      versionRange: "^1.0.0",
                      method: "inspect",
                      input: { terminalId },
                      context: session.context,
                    },
                    signal,
                  );
                  if (!signal.aborted)
                    setStatus(
                      result === null
                        ? "Terminal is not open."
                        : result.label +
                            ": " +
                            result.status +
                            (result.hasRunningSubprocess ? " — command running" : ""),
                    );
                } catch (error) {
                  if (!signal.aborted)
                    setStatus(
                      error instanceof Error ? error.message : "Terminal status unavailable.",
                    );
                }
              };
              return h(
                "section",
                {
                  "aria-label": "Installed terminal status",
                  style: { padding: 12, display: "grid", gap: 12, minWidth: 0 },
                },
                h(
                  "label",
                  { style: { display: "grid", gap: 6, minWidth: 0 } },
                  "Terminal ID",
                  h("input", {
                    style: { ...controlStyle, width: "100%", minWidth: 0, boxSizing: "border-box" },
                    value: terminalId,
                    maxLength: 128,
                    onChange: (event) => setTerminalId(event.target.value),
                  }),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    onClick: inspect,
                    disabled: !terminalId,
                    style: {
                      ...controlStyle,
                      justifySelf: "start",
                      cursor: terminalId ? "pointer" : "default",
                      opacity: terminalId ? 1 : 0.5,
                    },
                  },
                  "Read status",
                ),
                h("p", { role: "status", style: { margin: 0, overflowWrap: "anywhere" } }, status),
              );
            },
          };
        },
      },
    ],
  };
}
