const manifest = {
  id: "example.package-assets",
  version: "1.0.0",
  apiVersion: 1,
  surfaces: [
    {
      id: "example.package-assets/view",
      title: "Package asset demo",
      scope: "thread",
      placements: ["side-panel"],
      clients: ["web", "desktop"],
      capabilities: [],
      stateVersion: 1,
    },
  ],
};
export default function createAssetExample(host) {
  if (!host.readAsset) throw new Error("This host cannot load declared package assets.");
  const { createElement: h, useState, useRef, useEffect } = host.React;
  return {
    manifest,
    surfaces: [
      {
        id: "example.package-assets/view",
        validateRestore: (state) => state === null,
        createView(session) {
          return {
            renderer: function PackageAssetDemo() {
              const [status, setStatus] = useState("Load the installed WebAssembly asset.");
              const pending = useRef(null);
              useEffect(() => () => pending.current?.abort(), []);
              const load = async () => {
                pending.current?.abort();
                const controller = new AbortController();
                pending.current = controller;
                const signal = AbortSignal.any([controller.signal, session.signal]);
                setStatus("Loading asset…");
                try {
                  const asset = await host.readAsset("assets/value.wasm", signal);
                  if (signal.aborted) return;
                  const { instance } = await WebAssembly.instantiate(asset.bytes);
                  if (signal.aborted) return;
                  const value = instance.exports.value;
                  if (typeof value !== "function") throw new Error("Asset has no value export.");
                  setStatus("Installed WASM returned " + value() + ".");
                } catch (error) {
                  if (!signal.aborted)
                    setStatus(error instanceof Error ? error.message : "Asset unavailable.");
                }
              };
              return h(
                "section",
                {
                  "aria-label": "Installed package asset demo",
                  style: { padding: 12, display: "grid", gap: 12 },
                },
                h("button", { type: "button", onClick: load }, "Load package asset"),
                h("p", { role: "status" }, status),
              );
            },
          };
        },
      },
    ],
  };
}
