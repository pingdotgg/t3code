import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import { getFontFaces } from "./fonts.ts";
import printCss from "./print.css?raw";

/**
 * Converts markdown string to a full HTML5 document with embedded styles and fonts.
 *
 * Pure function: markdown string → full HTML5 document string.
 * Uses remarkGfm, remarkBreaks, and rehypeRaw (same as ChatMarkdown.tsx, WITHOUT rehype-sanitize).
 *
 * @param markdown - The markdown content to convert
 * @returns A complete HTML5 document string ready for PDF rendering
 */
export function markdownToHtml(markdown: string): string {
  // Render markdown to HTML using ReactMarkdown
  const bodyHtml = renderToStaticMarkup(
    React.createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkBreaks],
      rehypePlugins: [rehypeRaw],
      children: markdown,
    })
  );

  // Embed font-face declarations
  const fontFaces = getFontFaces();

  // Construct full HTML5 document
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Document</title>
  <style>
${fontFaces}

${printCss}
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}


