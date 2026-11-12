import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, preview } from "vite";

// The playground's prerender plugin: after the build, a preview server
// renders `/prerendered` into the client output.
export default defineConfig({
  plugins: [
    {
      name: "prerender-plugin",
      enforce: "post",
      buildApp: {
        order: "post",
        async handler(builder) {
          const previewServer = await preview({
            root: path.dirname(fileURLToPath(import.meta.url)),
            logLevel: "silent",
            preview: {
              port: 0,
            },
          });

          const baseUrl = previewServer.resolvedUrls?.local[0];
          const clientOutputDirectory = builder.environments.client?.config.build.outDir;

          if (baseUrl && clientOutputDirectory) {
            const response = await fetch(new URL("/prerendered", baseUrl));
            const html = await response.text();

            const outputDirectory = path.resolve(builder.config.root, clientOutputDirectory);
            await fsp.mkdir(outputDirectory, { recursive: true });
            await fsp.writeFile(path.join(outputDirectory, "prerendered.html"), html);

            console.log("Pre-rendered /prerendered");
          }

          await previewServer.close();
        },
      },
    },
  ],
});
