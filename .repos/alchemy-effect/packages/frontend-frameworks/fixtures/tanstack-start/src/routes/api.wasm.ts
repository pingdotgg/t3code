import { createFileRoute } from "@tanstack/react-router";

interface Instance {
  exports: {
    add(a: number, b: number): number;
  };
}

export const Route = createFileRoute("/api/wasm")({
  server: {
    handlers: {
      GET: async () => {
        const mod = await import("../wasm-example.wasm").then(
          (m) => WebAssembly.instantiate(m.default) as Promise<Instance>,
        );
        const result = mod.exports.add(1, 2);
        return Response.json({ result });
      },
    },
  },
});
