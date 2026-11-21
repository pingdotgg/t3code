import { CanvasColor, CanvasOp, type CanvasDocument, type CanvasNode } from "@t3tools/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { exportCanvasHtml } from "./canvasExport.ts";

const isCanvasColor = Schema.is(CanvasColor);
const isCanvasOp = Schema.is(CanvasOp);

const node = (fields: Partial<CanvasNode> & Pick<CanvasNode, "id" | "type">): CanvasNode => ({
  parentId: null,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  ...fields,
});

function documentOf(nodes: CanvasNode[]): CanvasDocument {
  return {
    version: 1,
    id: "doc",
    projectId: "project" as CanvasDocument["projectId"],
    name: "Doc",
    revision: 0,
    rootIds: nodes.filter((item) => item.parentId === null).map((item) => item.id),
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
    assets: {},
    createdAt: "",
    updatedAt: "",
  };
}

const classesOf = (html: string, name: string) =>
  new RegExp(`class="([^"]*)"[^>]*data-name="${name}"`).exec(html)?.[1]?.split(" ") ?? [];

describe("exportCanvasHtml", () => {
  it("keeps unfilled stroked paths and ellipses transparent", () => {
    for (const type of ["path", "ellipse"] as const) {
      const outline = node({
        id: "outline",
        type,
        path: "M0 0 L100 0 L100 100 Z",
        strokes: [{ color: "#112233", width: 2 }],
      });
      const html = exportCanvasHtml(documentOf([outline]), "outline");
      expect(html).toContain('fill="none" stroke="#112233"');
      expect(html).not.toContain('fill="#000000"');
    }
  });

  const doc = documentOf([
    node({
      id: "card",
      type: "frame",
      name: "Card",
      width: 320,
      height: 200,
      childIds: ["title", "button", "badge"],
      fills: [{ type: "solid", color: "#ffffff" }],
      cornerRadius: 12,
      shadows: [{ x: 0, y: 4, blur: 12, spread: 0, color: "#00000026" }],
      layout: { direction: "column", gap: 8, padding: [16, 16, 16, 16], align: "center" },
    }),
    node({
      id: "title",
      type: "text",
      name: "Title",
      parentId: "card",
      width: 120,
      height: 24,
      text: {
        content: "Hello <world>",
        fontSize: 20,
        fontWeight: 600,
        color: "#111111",
        sizing: "auto-width",
      },
    }),
    node({
      id: "button",
      type: "frame",
      name: "Button",
      parentId: "card",
      width: 288,
      height: 37,
      className: "self-stretch",
      fills: [
        {
          type: "linear-gradient",
          angle: 90,
          stops: [
            { offset: 0, color: "#ff0000" },
            { offset: 1, color: "#0000ff" },
          ],
        },
      ],
      animations: [
        {
          id: "pulse",
          property: "opacity",
          durationMs: 800,
          loop: true,
          alternate: true,
          keyframes: [
            { offset: 0, value: 1, easing: "ease-in-out" },
            { offset: 1, value: 0.5 },
          ],
        },
      ],
    }),
    node({
      id: "badge",
      type: "ellipse",
      name: "Badge",
      parentId: "card",
      x: 300,
      y: -6,
      width: 12,
      height: 12,
      className: "absolute",
      fills: [{ type: "solid", color: "#ff0000" }],
    }),
  ]);

  it("emits flex layout, scale or arbitrary utilities, and keeps imported classes", () => {
    const html = exportCanvasHtml(doc, "card");
    const card = classesOf(html, "Card");
    expect(card).toEqual(
      expect.arrayContaining([
        "relative",
        "w-80",
        "h-50",
        "flex",
        "flex-col",
        "gap-2",
        "p-4",
        "items-center",
        "bg-white",
        "rounded-xl",
        "shadow-[0px_4px_12px_0px_#00000026]",
      ]),
    );
    expect(html.startsWith("<style>")).toBe(true);
    expect(html).toContain('<h3 class="');
    expect(html).toContain("Hello &lt;world&gt;</h3>");
    expect(classesOf(html, "Title")).toEqual(
      expect.arrayContaining(["text-xl", "font-semibold", "text-[#111111]", "whitespace-pre"]),
    );
    expect(classesOf(html, "Title").some((token) => token.startsWith("w-"))).toBe(false);

    // self-stretch replaces the fixed width in a column, the height stays.
    const button = classesOf(html, "Button");
    expect(button).toEqual(
      expect.arrayContaining([
        "self-stretch",
        "h-[37px]",
        "bg-[linear-gradient(90deg,_#ff0000_0%,_#0000ff_100%)]",
      ]),
    );
    expect(button.some((token) => token.startsWith("w-"))).toBe(false);
    expect(html).toMatch(/^\s*<button /m);

    // Absolute children of an auto layout frame keep their coordinates.
    expect(classesOf(html, "Badge")).toEqual(
      expect.arrayContaining([
        "absolute",
        "left-75",
        "-top-1.5",
        "w-3",
        "h-3",
        "rounded-full",
        "bg-[#ff0000]",
      ]),
    );
  });

  it("emits keyframes and an animation class for animated nodes", () => {
    const html = exportCanvasHtml(doc, "card");
    expect(html).toContain("@keyframes canvas-button-pulse {");
    expect(html).toContain("0% { opacity: 1; animation-timing-function: ease-in-out; }");
    expect(html).toContain("100% { opacity: 0.5; }");
    expect(html).toContain(
      ".canvas-anim-button { animation: canvas-button-pulse 800ms ease 0ms infinite alternate both; }",
    );
    expect(classesOf(html, "Button")).toContain("canvas-anim-button");
  });

  it("rejects markup in wire colors and safely exports invalid legacy animation colors", () => {
    for (const color of ["#abcdef", "#ABCDEF", "#abcdef80"])
      expect(isCanvasColor(color)).toBe(true);
    const legacy = node({
      id: "unsafe",
      type: "rect",
      name: "Legacy",
      fills: [{ type: "solid", color: "</style>" }],
      animations: [
        {
          id: "fill",
          property: "fill",
          durationMs: 500,
          keyframes: [
            { offset: 0, value: "</style>" },
            { offset: 1, value: "#ABCDEF80" },
          ],
        },
      ],
    });
    expect(isCanvasOp({ op: "insert", node: legacy })).toBe(false);
    const html = exportCanvasHtml(documentOf([legacy]));
    expect(html.match(/<\/style>/g)).toHaveLength(1);
    expect(html).toContain("0% { background-color: #000000; }");
    expect(html).toContain("100% { background-color: #abcdef80; }");
    expect(classesOf(html, "Legacy")).toContain("bg-black");
  });

  it("preserves image sizing and radial gradient geometry", () => {
    const doc = documentOf(
      (["stretch", "fit", "fill"] as const).map((fit) =>
        node({
          id: fit,
          name: fit,
          type: "rect",
          width: 200,
          height: 100,
          fills: [
            { type: "image", assetId: "photo", fit },
            {
              type: "radial-gradient",
              center: { x: 0.164, y: -0.111 },
              size: { width: 1.5, height: 1.9 },
              stops: [
                { offset: 0, color: "#ffffff" },
                { offset: 1, color: "#000000" },
              ],
            },
          ],
        }),
      ),
    );
    const html = exportCanvasHtml({
      ...doc,
      assets: {
        photo: {
          id: "photo",
          mimeType: "image/png",
          url: "data:image/png;base64,AA==",
          width: 100,
          height: 200,
        },
      },
    });
    expect(classesOf(html, "stretch")).toContain("bg-size-[100%_100%]");
    expect(classesOf(html, "fit")).toContain("bg-contain");
    expect(classesOf(html, "fill")).toContain("bg-cover");
    expect(html).toContain("data:image/png;base64,AA==");
    expect(html).toContain(
      "radial-gradient(ellipse 75% 95% at 16.4% -11.1%, #ffffff 0%, #000000 100%)",
    );
  });

  it("exports every root on a board positioned from the top-left root", () => {
    const html = exportCanvasHtml(
      documentOf([
        node({ id: "a", type: "rect", name: "A", x: -50, y: 10, width: 40, height: 40 }),
        node({ id: "b", type: "rect", name: "B", x: 50, y: 30, width: 20, height: 20 }),
      ]),
    );
    expect(html).not.toContain("<style>");
    expect(classesOf(html, "Doc")).toEqual(expect.arrayContaining(["relative", "w-30", "h-10"]));
    expect(classesOf(html, "A")).toEqual(expect.arrayContaining(["absolute", "left-0", "top-0"]));
    expect(classesOf(html, "B")).toEqual(expect.arrayContaining(["absolute", "left-25", "top-5"]));
  });
});
