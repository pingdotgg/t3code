import { defineConfig } from "vite";

// A client target that predates `using` (the playground's): the Worker's own
// target must not leak into the client build.
export default defineConfig({
  build: { target: "es2024" },
});
