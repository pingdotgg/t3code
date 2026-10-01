const manifest = {
  id: "example.stream-provider",
  apiVersion: 1,
  version: "1.0.0",
  surfaces: [
    {
      id: "example.stream-provider/view",
      title: "Shared counter",
      scope: "project",
      placements: ["side-panel"],
      clients: ["web", "desktop"],
      capabilities: [],
      stateVersion: 1,
    },
  ],
};
const api = "example.stream-provider/state";
export default function createCounter(host) {
  const { createElement: h, useState, useEffect, useRef } = host.React;
  return {
    manifest,
    surfaces: [
      {
        id: manifest.id + "/view",
        validateRestore: (state) => state === null,
        createView(session) {
          return {
            renderer: function Counter() {
              const [value, setValue] = useState(null);
              const [error, setError] = useState(null);
              const [busy, setBusy] = useState(false);
              const viewController = useRef(null);
              useEffect(() => {
                const controller = new AbortController();
                viewController.current = controller;
                const signal = AbortSignal.any([controller.signal, session.signal]);
                void (async () => {
                  try {
                    for await (const frame of host.subscribeApi(
                      {
                        id: api,
                        versionRange: "^1.0.0",
                        name: "changes",
                        input: {},
                        context: session.context,
                      },
                      signal,
                    )) {
                      if (signal.aborted) return;
                      setValue(frame.value);
                    }
                  } catch (cause) {
                    if (!signal.aborted) setError(cause.message);
                  }
                })();
                return () => controller.abort();
              }, []);
              return h(
                "section",
                { "aria-label": "Shared counter" },
                h("h2", null, "Shared counter"),
                h(
                  "output",
                  { "aria-label": "Counter value" },
                  value ? String(value.count) : "Waiting",
                ),
                h(
                  "button",
                  {
                    type: "button",
                    disabled: busy,
                    onClick: async () => {
                      setBusy(true);
                      try {
                        await host.invokeApi(
                          {
                            id: api,
                            versionRange: "^1.0.0",
                            method: "increment",
                            input: {},
                            context: session.context,
                          },
                          AbortSignal.any([session.signal, viewController.current.signal]),
                        );
                      } catch (cause) {
                        if (!session.signal.aborted && !viewController.current.signal.aborted)
                          setError(cause.message);
                      } finally {
                        if (!session.signal.aborted && !viewController.current.signal.aborted)
                          setBusy(false);
                      }
                    },
                  },
                  "Increment",
                ),
                error ? h("p", { role: "alert" }, error) : null,
              );
            },
          };
        },
      },
    ],
  };
}
