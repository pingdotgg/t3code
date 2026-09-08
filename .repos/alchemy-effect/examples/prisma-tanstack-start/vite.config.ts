import { prismaVitePlugin } from "@prisma-next/vite-plugin-contract-emit";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  server: { port: Number(process.env.PORT ?? "3000") },
  plugins: [
    tanstackStart({ router: { quoteStyle: "double", semicolons: true } }),
    nitro(),
    prismaVitePlugin("prisma-next.config.ts", { logLevel: "silent" }),
    // React's Vite plugin must come after TanStack Start.
    viteReact(),
  ],
});
