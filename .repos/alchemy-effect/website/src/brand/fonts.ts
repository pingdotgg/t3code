import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Font } from "takumi-js";

export const brandFonts = await Promise.all(
  [
    {
      name: "Source Serif 4",
      style: "normal",
      file: import.meta
        .resolve("@fontsource-variable/source-serif-4/files/source-serif-4-latin-opsz-normal.woff2"),
    },
    {
      name: "Source Serif 4",
      style: "italic",
      file: import.meta
        .resolve("@fontsource-variable/source-serif-4/files/source-serif-4-latin-opsz-italic.woff2"),
    },
    {
      name: "JetBrains Mono",
      style: "normal",
      file: import.meta
        .resolve("@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2"),
    },
    {
      name: "Caveat",
      style: "normal",
      file: import.meta
        .resolve("@fontsource-variable/caveat/files/caveat-latin-wght-normal.woff2"),
    },
  ].map(
    async ({ name, style, file }) =>
      ({
        name,
        style,
        data: await readFile(fileURLToPath(file)),
      }) satisfies Font,
  ),
);
