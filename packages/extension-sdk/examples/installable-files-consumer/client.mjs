const manifest = {
  id: "example.files-consumer",
  apiVersion: 1,
  version: "1.0.0",
  surfaces: [
    {
      id: "example.files-consumer/view",
      title: "Files API consumer",
      scope: "project",
      placements: ["side-panel"],
      clients: ["web", "desktop"],
      capabilities: [],
      stateVersion: 1,
    },
  ],
};

/** Independently packaged consumer: no private app modules, own tool bridge or UI imports. */
export default function createConsumer(host) {
  const { createElement: h, useState, useEffect } = host.React;
  return {
    manifest,
    surfaces: [
      {
        id: manifest.id + "/view",
        validateRestore: (state) => state === null,
        createView(session) {
          return {
            renderer: function Consumer() {
              const [result, setResult] = useState("Loading provider metadata");
              useEffect(() => {
                const controller = new AbortController();
                const signal = AbortSignal.any([controller.signal, session.signal]);
                host
                  .invokeApi(
                    {
                      id: "example.files/info",
                      versionRange: "^1.0.0",
                      method: "describe",
                      input: {},
                      context: session.context,
                    },
                    signal,
                  )
                  .then(
                    (value) => {
                      if (!signal.aborted)
                        setResult(value.title + (value.readOnly ? " (read only)" : ""));
                    },
                    (error) => {
                      if (!signal.aborted) setResult(error.message);
                    },
                  );
                return () => controller.abort();
              }, []);
              return h(
                "section",
                { "aria-label": "Independent Files API consumer" },
                h("h2", null, "Files provider metadata"),
                h("p", { role: "status" }, result),
              );
            },
          };
        },
      },
    ],
  };
}
