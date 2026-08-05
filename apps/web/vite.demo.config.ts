import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite-plus";
import pkg from "./package.json" with { type: "json" };

// Builds the marketing sidebar demo: the real web app bundled against the
// in-browser demo backend (src/demo), emitted into the marketing site's
// public/ directory so it can be embedded as an iframe.
export default defineConfig(() => {
  return {
    plugins: [
      tanstackRouter(),
      react(),
      babel({
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [reactCompilerPreset()],
      }),
      tailwindcss(),
    ],
    base: "/sidebar-demo/",
    define: {
      "import.meta.env.VITE_WS_URL": JSON.stringify(""),
      "import.meta.env.VITE_T3CODE_RELAY_URL": JSON.stringify(""),
      "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify(""),
      "import.meta.env.VITE_CLERK_JWT_TEMPLATE": JSON.stringify(""),
      "import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID": JSON.stringify(""),
      "import.meta.env.VITE_RELAY_OTLP_TRACES_URL": JSON.stringify(""),
      "import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET": JSON.stringify(""),
      "import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN": JSON.stringify(""),
      "import.meta.env.VITE_HOSTED_APP_URL": JSON.stringify(""),
      "import.meta.env.VITE_HOSTED_APP_CHANNEL": JSON.stringify(""),
      "import.meta.env.VITE_T3CODE_DEMO": JSON.stringify("true"),
      "import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
    },
    resolve: {
      tsconfigPaths: true,
      // The demo bundles workspace sources together, so they must all share the
      // same Effect runtime and HttpApi endpoint representation.
      dedupe: ["effect", "react", "react-dom"],
    },
    build: {
      outDir: "../marketing/public/sidebar-demo",
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        input: ["demo.html", "stage-art.html"],
      },
    },
  };
});
