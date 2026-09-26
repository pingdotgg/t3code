import { defineExtension } from "@t3tools/extension-sdk/authoring";

export default defineExtension({
  id: "example.authored-assets",
  version: "1.0.0",
  assets: [{ path: "assets/value.wasm", mediaType: "application/wasm" }],
  surfaces: [
    {
      name: "view",
      title: "Authored package asset demo",
      scope: "thread",
      createView(host, session) {
        return {
          renderer: function AuthoredAssetDemo() {
            const { createElement: h, useState, useRef, useEffect } = host.React;
            const [status, setStatus] = useState("Load the installed WebAssembly asset.");
            const pending = useRef<AbortController | null>(null);
            useEffect(() => () => pending.current?.abort(), []);
            const load = async () => {
              pending.current?.abort();
              const controller = new AbortController();
              pending.current = controller;
              const signal = AbortSignal.any([controller.signal, session.signal]);
              setStatus("Loading asset…");
              try {
                if (!host.readAsset) throw new Error("This host cannot load package assets.");
                const asset = await host.readAsset("assets/value.wasm", signal);
                if (signal.aborted) return;
                const module = await WebAssembly.compile(asset.bytes as BufferSource);
                if (signal.aborted) return;
                const value = new WebAssembly.Instance(module).exports.value;
                if (typeof value !== "function") throw new Error("Asset has no value export.");
                setStatus("Installed WASM returned " + String((value as () => number)()) + ".");
              } catch (error) {
                if (!signal.aborted)
                  setStatus(error instanceof Error ? error.message : "Asset unavailable.");
              }
            };
            return h(
              "section",
              {
                "aria-label": "Authored package asset demo",
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
});
