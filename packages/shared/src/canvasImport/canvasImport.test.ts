import type { CanvasNode } from "@t3tools/contracts";
import { deflateSync, zipSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";

import { importCanvasFile } from "./index.ts";
import { decodeKiwiMessage, decodeKiwiSchema, type KiwiSchema } from "./kiwi.ts";
import { DecodeBudget, ImportLimitError, inflateWithin, zstdWithin } from "./limits.ts";
import { evenOddToNonzero, parseSvgPath, serializePath } from "./svgPath.ts";

const encoder = new TextEncoder();

// A tiny kiwi writer, mirroring evanw/kiwi's ByteBuffer, to build fixtures.

class Writer {
  bytes: number[] = [];
  byte(value: number) {
    this.bytes.push(value & 255);
  }
  varUint(value: number) {
    do {
      const byte = value & 127;
      value >>>= 7;
      this.byte(value ? byte | 128 : byte);
    } while (value);
  }
  varInt(value: number) {
    this.varUint((value << 1) ^ (value >> 31));
  }
  varFloat(value: number) {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value);
    let bits = view.getInt32(0);
    bits = (bits >>> 23) | (bits << 9);
    if ((bits & 255) === 0) {
      this.byte(0);
      return;
    }
    this.byte(bits);
    this.byte(bits >> 8);
    this.byte(bits >> 16);
    this.byte(bits >> 24);
  }
  string(value: string) {
    for (const byte of encoder.encode(value)) this.byte(byte);
    this.byte(0);
  }
  toBytes() {
    return new Uint8Array(this.bytes);
  }
}

const BUILTINS = ["bool", "byte", "int", "uint", "float", "string", "int64", "uint64"];

function encodeSchema(schema: KiwiSchema): Uint8Array {
  const writer = new Writer();
  const index = new Map(schema.definitions.map((definition, i) => [definition.name, i]));
  writer.varUint(schema.definitions.length);
  for (const definition of schema.definitions) {
    writer.string(definition.name);
    writer.byte(["ENUM", "STRUCT", "MESSAGE"].indexOf(definition.kind));
    writer.varUint(definition.fields.length);
    for (const field of definition.fields) {
      writer.string(field.name);
      const builtin = field.type === null ? -1 : BUILTINS.indexOf(field.type);
      writer.varInt(field.type === null ? 0 : builtin >= 0 ? ~builtin : index.get(field.type)!);
      writer.byte(field.isArray ? 1 : 0);
      writer.varUint(field.value);
    }
  }
  return writer.toBytes();
}

function encodeMessage(
  schema: KiwiSchema,
  type: string,
  value: Record<string, unknown>,
): Uint8Array {
  const writer = new Writer();
  const byName = new Map(schema.definitions.map((definition) => [definition.name, definition]));
  const writeValue = (fieldType: string, item: unknown) => {
    switch (fieldType) {
      case "bool":
        return writer.byte(item ? 1 : 0);
      case "byte":
        return writer.byte(item as number);
      case "int":
        return writer.varInt(item as number);
      case "uint":
        return writer.varUint(item as number);
      case "float":
        return writer.varFloat(item as number);
      case "string":
        return writer.string(item as string);
    }
    const definition = byName.get(fieldType)!;
    if (definition.kind === "ENUM") {
      writer.varUint(definition.fields.find((field) => field.name === item)!.value);
    } else {
      write(fieldType, item as Record<string, unknown>);
    }
  };
  const write = (name: string, object: Record<string, unknown>) => {
    const definition = byName.get(name)!;
    for (const field of definition.fields) {
      const item = object[field.name];
      if (definition.kind === "MESSAGE" && item === undefined) continue;
      if (definition.kind === "MESSAGE") writer.varUint(field.value);
      if (field.isArray) {
        const list = item as unknown[];
        writer.varUint(list.length);
        for (const element of list) writeValue(field.type!, element);
      } else {
        writeValue(field.type!, item);
      }
    }
    if (definition.kind === "MESSAGE") writer.varUint(0);
  };
  write(type, value);
  return writer.toBytes();
}

const field = (name: string, type: string | null, value: number, isArray = false) => ({
  name,
  type,
  value,
  isArray,
});
const enumOf = (name: string, values: string[]) => ({
  name,
  kind: "ENUM" as const,
  fields: values.map((value, index) => field(value, null, index)),
});

/** The subset of Figma's schema this fixture uses; field numbers are arbitrary but consistent. */
const FIG_SCHEMA: KiwiSchema = {
  definitions: [
    enumOf("NodeType", [
      "NONE",
      "DOCUMENT",
      "CANVAS",
      "FRAME",
      "RECTANGLE",
      "TEXT",
      "SYMBOL",
      "INSTANCE",
    ]),
    enumOf("PaintType", ["SOLID", "GRADIENT_LINEAR"]),
    enumOf("StackMode", ["NONE", "HORIZONTAL", "VERTICAL"]),
    {
      name: "GUID",
      kind: "STRUCT",
      fields: [field("sessionID", "uint", 1), field("localID", "uint", 2)],
    },
    {
      name: "Color",
      kind: "STRUCT",
      fields: [
        field("r", "float", 1),
        field("g", "float", 2),
        field("b", "float", 3),
        field("a", "float", 4),
      ],
    },
    { name: "Vector", kind: "STRUCT", fields: [field("x", "float", 1), field("y", "float", 2)] },
    {
      name: "Matrix",
      kind: "STRUCT",
      fields: ["m00", "m01", "m02", "m10", "m11", "m12"].map((name, index) =>
        field(name, "float", index + 1),
      ),
    },
    {
      name: "ParentIndex",
      kind: "MESSAGE",
      fields: [field("guid", "GUID", 1), field("position", "string", 2)],
    },
    {
      name: "Paint",
      kind: "MESSAGE",
      fields: [
        field("type", "PaintType", 1),
        field("color", "Color", 2),
        field("opacity", "float", 3),
        field("visible", "bool", 4),
      ],
    },
    { name: "TextData", kind: "MESSAGE", fields: [field("characters", "string", 1)] },
    { name: "GUIDPath", kind: "MESSAGE", fields: [field("guids", "GUID", 1, true)] },
    {
      name: "NodeChange",
      kind: "MESSAGE",
      fields: [
        field("guid", "GUID", 1),
        field("parentIndex", "ParentIndex", 2),
        field("type", "NodeType", 3),
        field("name", "string", 4),
        field("size", "Vector", 5),
        field("transform", "Matrix", 6),
        field("fillPaints", "Paint", 7, true),
        field("stackMode", "StackMode", 8),
        field("stackSpacing", "float", 9),
        field("textData", "TextData", 10),
        field("fontSize", "float", 11),
        field("symbolData", "SymbolData", 12),
        field("overrideKey", "GUID", 13),
        field("guidPath", "GUIDPath", 14),
        field("cornerRadius", "float", 15),
      ],
    },
    {
      name: "SymbolData",
      kind: "MESSAGE",
      fields: [field("symbolID", "GUID", 1), field("symbolOverrides", "NodeChange", 2, true)],
    },
    { name: "Message", kind: "MESSAGE", fields: [field("nodeChanges", "NodeChange", 1, true)] },
  ],
};

const guid = (localID: number) => ({ sessionID: 1, localID });
const at = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const solid = (r: number, g: number, b: number) => ({
  type: "SOLID",
  color: { r, g, b, a: 1 },
  opacity: 1,
  visible: true,
});

function buildFig(nodeChanges: Array<Record<string, unknown>>): Uint8Array {
  const schema = deflateSync(encodeSchema(FIG_SCHEMA));
  const message = deflateSync(encodeMessage(FIG_SCHEMA, "Message", { nodeChanges }), { level: 1 });
  const header = encoder.encode("fig-kiwi");
  const out = new Uint8Array(12 + 4 + schema.length + 4 + message.length);
  const view = new DataView(out.buffer);
  out.set(header, 0);
  view.setUint32(8, 20, true);
  view.setUint32(12, schema.length, true);
  out.set(schema, 16);
  view.setUint32(16 + schema.length, message.length, true);
  out.set(message, 20 + schema.length);
  return out;
}

const FIG_NODES = [
  { guid: guid(0), type: "DOCUMENT", name: "Document" },
  { guid: guid(1), parentIndex: { guid: guid(0), position: "!" }, type: "CANVAS", name: "Page 1" },
  {
    guid: guid(2),
    parentIndex: { guid: guid(1), position: "!" },
    type: "FRAME",
    name: "Card",
    size: { x: 200, y: 100 },
    transform: at(10, 20),
    fillPaints: [solid(1, 1, 1)],
    stackMode: "VERTICAL",
    stackSpacing: 8,
  },
  {
    guid: guid(3),
    parentIndex: { guid: guid(2), position: "!" },
    type: "TEXT",
    name: "Title",
    size: { x: 80, y: 20 },
    transform: at(0, 0),
    fillPaints: [solid(0, 0, 0)],
    textData: { characters: "Hello" },
    fontSize: 16,
  },
  {
    guid: guid(4),
    parentIndex: { guid: guid(2), position: "#" },
    type: "RECTANGLE",
    name: "Bar",
    size: { x: 200, y: 10 },
    transform: at(0, 28),
    fillPaints: [solid(1, 0, 0)],
    cornerRadius: 4,
  },
  // A component and an instance that overrides its label.
  {
    guid: guid(5),
    parentIndex: { guid: guid(1), position: "$" },
    type: "SYMBOL",
    name: "Button",
    size: { x: 100, y: 40 },
    transform: at(300, 0),
  },
  {
    guid: guid(6),
    parentIndex: { guid: guid(5), position: "!" },
    type: "TEXT",
    name: "Label",
    size: { x: 60, y: 20 },
    transform: at(20, 10),
    textData: { characters: "Button" },
    fontSize: 14,
    overrideKey: guid(60),
  },
  {
    guid: guid(7),
    parentIndex: { guid: guid(1), position: "%" },
    type: "INSTANCE",
    name: "Save button",
    size: { x: 100, y: 40 },
    transform: at(300, 100),
    symbolData: {
      symbolID: guid(5),
      symbolOverrides: [{ guidPath: { guids: [guid(60)] }, textData: { characters: "Save" } }],
    },
  },
];

const nodesByName = (nodes: Record<string, CanvasNode>) => {
  const map = new Map<string, CanvasNode>();
  for (const node of Object.values(nodes))
    if (node.name && !map.has(node.name)) map.set(node.name, node);
  return map;
};

describe("kiwi", () => {
  it("round-trips a binary schema and decodes messages by field tag", () => {
    const schema = decodeKiwiSchema(encodeSchema(FIG_SCHEMA));
    expect(schema.definitions.map((definition) => definition.name)).toEqual(
      FIG_SCHEMA.definitions.map((definition) => definition.name),
    );
    const bytes = encodeMessage(FIG_SCHEMA, "Message", {
      nodeChanges: [
        { guid: guid(9), type: "TEXT", name: "héllo", fontSize: 12.5, size: { x: 0, y: -3 } },
      ],
    });
    expect(decodeKiwiMessage(schema, "Message", bytes)).toEqual({
      nodeChanges: [
        { guid: guid(9), type: "TEXT", name: "héllo", fontSize: 12.5, size: { x: 0, y: -3 } },
      ],
    });
  });
});

describe("decode limits", () => {
  it("stops inflating once the output passes the budget", () => {
    const compressed = deflateSync(new Uint8Array(1_000_000));
    expect(inflateWithin(compressed, new DecodeBudget(2_000_000)).length).toBe(1_000_000);
    expect(() => inflateWithin(compressed, new DecodeBudget(100_000))).toThrow(ImportLimitError);
  });

  it("bounds every Zstandard frame window before decoding, including concatenated frames", () => {
    const small = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 1, 9, 0, 0, 0x41]);
    const largeWindow = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0xa0, 9, 0, 0, 0x41]);
    const largeSingleSegment = Uint8Array.from([
      0x28, 0xb5, 0x2f, 0xfd, 0xa0, 0, 0, 0, 0x40, 1, 0, 0,
    ]);
    expect(zstdWithin(small, new DecodeBudget())).toEqual(encoder.encode("A"));
    expect(() => zstdWithin(largeWindow, new DecodeBudget())).toThrow(ImportLimitError);
    expect(() => zstdWithin(largeSingleSegment, new DecodeBudget())).toThrow(ImportLimitError);
    expect(() =>
      zstdWithin(Uint8Array.from([...small, ...largeWindow]), new DecodeBudget()),
    ).toThrow(ImportLimitError);
    const skippable = [0x50, 0x2a, 0x4d, 0x18, 1, 0, 0, 0, 0];
    expect(zstdWithin(Uint8Array.from([...skippable, ...small]), new DecodeBudget())).toEqual(
      encoder.encode("A"),
    );
  });
});

describe("importCanvasFile .fig", () => {
  it("maps pages, auto layout, paints, text, and expands instances with overrides", async () => {
    const result = await importCanvasFile("design.fig", buildFig(FIG_NODES));
    expect(result.warnings).toEqual([]);
    expect(result.rootIds).toHaveLength(1);
    const page = result.nodes[result.rootIds[0]!]!;
    expect(page).toMatchObject({
      type: "frame",
      name: "Page 1",
      x: 0,
      y: 0,
      width: 390,
      height: 140,
    });

    const byName = nodesByName(result.nodes);
    expect(byName.get("Card")).toMatchObject({
      type: "frame",
      x: 0,
      y: 20,
      width: 200,
      height: 100,
      fills: [{ type: "solid", color: "#ffffff" }],
      layout: { direction: "column", gap: 8 },
      parentId: page.id,
    });
    expect(byName.get("Bar")).toMatchObject({
      type: "rect",
      y: 28,
      cornerRadius: 4,
      fills: [{ type: "solid", color: "#ff0000" }],
    });
    expect(byName.get("Title")?.text).toMatchObject({
      content: "Hello",
      fontSize: 16,
      color: "#000000",
    });

    const instance = byName.get("Save button")!;
    expect(instance).toMatchObject({ type: "frame", x: 290, y: 100 });
    const label = result.nodes[instance.childIds![0]!]!;
    expect(label.text?.content).toBe("Save");
    // The component itself keeps its own text.
    expect(byName.get("Label")?.text?.content).toBe("Button");
  });

  it("reads a zipped Figma download and reports garbage without throwing", async () => {
    const zipped = zipSync({
      "canvas.fig": buildFig(FIG_NODES),
      "meta.json": encoder.encode("{}"),
    });
    const result = await importCanvasFile("design.fig", zipped);
    expect(Object.keys(result.nodes).length).toBeGreaterThan(5);

    const broken = await importCanvasFile(
      "broken.fig",
      encoder.encode("fig-kiwi\u0001\u0000\u0000\u0000junk"),
    );
    expect(broken.rootIds).toEqual([]);
    expect(broken.warnings[0]).toMatch(/Could not import broken\.fig/);
  });
});

describe("importCanvasFile .pen", () => {
  const pen = {
    version: "2.20",
    themes: { mode: ["light", "dark"] },
    variables: {
      "color.bg": {
        type: "color",
        value: [
          { value: "#FFFFFF", theme: { mode: "light" } },
          { value: "#000000", theme: { mode: "dark" } },
        ],
      },
      gap: { type: "number", value: 10 },
    },
    children: [
      {
        id: "button",
        type: "frame",
        reusable: true,
        x: 0,
        y: 0,
        padding: [4, 8],
        fill: "$color.bg",
        children: [{ id: "label", type: "text", content: "OK", fontSize: 10, fill: "#111111" }],
      },
      {
        id: "dialog",
        type: "frame",
        reusable: true,
        x: 0,
        y: 100,
        width: 300,
        layout: "vertical",
        gap: "$gap",
        children: [
          { id: "message", type: "text", content: "Hi", fontSize: 10 },
          {
            id: "confirm",
            type: "ref",
            ref: "button",
            width: "fill_container",
            descendants: { label: { content: "Yes" } },
          },
        ],
      },
      // Dark themed instance overriding a nested descendant by path.
      {
        id: "save",
        type: "ref",
        ref: "dialog",
        x: 400,
        y: 100,
        theme: { mode: "dark" },
        descendants: { "confirm/label": { content: "Save" } },
      },
      {
        id: "row",
        type: "frame",
        x: 0,
        y: 300,
        width: 200,
        height: 50,
        justifyContent: "space_between",
        alignItems: "center",
        children: [
          {
            id: "a",
            type: "rectangle",
            width: 20,
            height: 20,
            fill: [
              {
                type: "gradient",
                gradientType: "linear",
                rotation: 90,
                colors: [
                  { color: "#ff0000", position: 0 },
                  { color: "#0000ff", position: 1 },
                ],
              },
              {
                type: "gradient",
                gradientType: "radial",
                size: { width: 1.5, height: 1.9 },
                colors: [{ color: "#1538d0", position: 0 }],
              },
              {
                type: "gradient",
                gradientType: "radial",
                center: { y: 0.43 },
                size: { width: 1.22, height: 2.17 },
                colors: [{ color: "#ffffff", position: 0 }],
              },
              {
                type: "gradient",
                gradientType: "radial",
                center: { x: 0.164, y: -0.111 },
                colors: [{ color: "#ffffff", position: 0 }],
              },
            ],
          },
          {
            id: "b",
            type: "rectangle",
            width: 30,
            height: 10,
            stroke: { align: "inside", thickness: 2, fill: "#00ff00" },
          },
        ],
      },
    ],
  };

  it("expands refs with overrides, resolves themed variables, and lays out flex children", async () => {
    // Comments are allowed in .pen files.
    const text = `// design\n${JSON.stringify(pen)}`;
    const result = await importCanvasFile("design.pen", encoder.encode(text));
    expect(result.warnings).toEqual([]);
    const roots = result.rootIds.map((id) => result.nodes[id]!);
    expect(roots.map((node) => node.type)).toEqual(["frame", "frame", "frame", "frame"]);

    const [button, dialog, save, row] = roots as [CanvasNode, CanvasNode, CanvasNode, CanvasNode];
    // Fit-content frame around a padded text label.
    expect(button).toMatchObject({
      fills: [{ type: "solid", color: "#ffffff" }],
      layout: { direction: "row", padding: [4, 8, 4, 8] },
    });
    expect(button.width).toBeGreaterThan(16);

    const childText = (node: CanvasNode) => result.nodes[node.childIds![0]!]!.text?.content;
    const [, dialogConfirm] = dialog.childIds!.map((id) => result.nodes[id]!);
    expect(childText(dialogConfirm!)).toBe("Yes");
    expect(dialogConfirm).toMatchObject({ x: 0, width: 300, className: "self-stretch h-fit" });
    expect(dialog.layout).toEqual({ direction: "column", gap: 10 });

    const [, saveConfirm] = save.childIds!.map((id) => result.nodes[id]!);
    expect(childText(saveConfirm!)).toBe("Save");
    expect(saveConfirm!.fills).toEqual([{ type: "solid", color: "#000000" }]);
    expect(save).toMatchObject({ x: 400, y: 100, width: 300 });

    const [a, b] = row.childIds!.map((id) => result.nodes[id]!);
    expect(a).toMatchObject({
      x: 0,
      y: 15,
      fills: [
        { type: "linear-gradient", angle: 270 },
        { type: "radial-gradient", center: { x: 0.5, y: 0.5 }, size: { width: 1.5, height: 1.9 } },
        {
          type: "radial-gradient",
          center: { x: 0.5, y: 0.43 },
          size: { width: 1.22, height: 2.17 },
        },
        { type: "radial-gradient", center: { x: 0.164, y: -0.111 }, size: { width: 1, height: 1 } },
      ],
    });
    expect(b).toMatchObject({
      x: 170,
      y: 20,
      strokes: [{ color: "#00ff00", width: 2, align: "inside" }],
    });
  });

  it("resolves image fills from a zip snapshot and lays documents side by side", async () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0,
      2, 0, 0, 0, 3, 8, 6, 0, 0, 0,
    ]);
    const photo = {
      version: "2.20",
      children: [
        {
          id: "p",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 50,
          height: 40,
          fill: { type: "image", url: "./img/photo.png", mode: "contain" },
        },
        {
          id: "stretched",
          type: "rectangle",
          x: 60,
          y: 0,
          width: 50,
          height: 40,
          fill: { type: "image", url: "./img/photo.png", mode: "stretch" },
        },
        {
          id: "covered",
          type: "rectangle",
          x: 120,
          y: 0,
          width: 50,
          height: 40,
          fill: { type: "image", url: "./img/photo.png", mode: "cover" },
        },
      ],
    };
    const zip = zipSync({
      "a/photo.pen": encoder.encode(JSON.stringify(photo)),
      "a/img/photo.png": png,
      "b.pen": encoder.encode(JSON.stringify(pen)),
    });
    const result = await importCanvasFile("snapshot.zip", zip);
    expect(result.warnings).toEqual([]);
    const roots = result.rootIds.map((id) => result.nodes[id]!);
    expect(roots.map((node) => node.name)).toEqual(["photo", "b"]);
    expect(roots[1]!.x).toBe(roots[0]!.width + 200);

    const rect = result.nodes[roots[0]!.childIds![0]!]!;
    const paint = rect.fills?.[0];
    expect(paint).toMatchObject({ type: "image", fit: "fit" });
    const asset = paint?.type === "image" ? result.assets[paint.assetId] : undefined;
    expect(asset).toMatchObject({ mimeType: "image/png", width: 2, height: 3 });
    expect(asset?.url.startsWith("data:image/png;base64,")).toBe(true);
    expect(roots[0]!.childIds!.map((id) => result.nodes[id]!.fills?.[0])).toEqual([
      { type: "image", assetId: asset!.id, fit: "fit" },
      { type: "image", assetId: asset!.id, fit: "stretch" },
      { type: "image", assetId: asset!.id, fit: "fill" },
    ]);
  });

  it("imports rounded material symbols as filled editable paths and preserves flips", async () => {
    const result = await importCanvasFile(
      "icons.pen",
      encoder.encode(
        JSON.stringify({
          children: [
            {
              type: "icon",
              id: "search",
              library: "Material Symbols Rounded",
              icon: "search",
              width: 48,
              height: 24,
              fill: "#123456",
            },
            {
              type: "icon_font",
              id: "flipped",
              iconFontFamily: "Material Symbols Rounded",
              iconFontName: "search",
              width: 48,
              height: 24,
              fill: "#123456",
              flipX: true,
            },
            {
              type: "icon",
              id: "folder",
              library: "Material Symbols Rounded",
              icon: "folder_open",
              width: 24,
              height: 24,
              fill: "#abcdef",
            },
          ],
        }),
      ),
    );
    expect(result.warnings).toEqual([]);
    const [search, flipped, folder] = result.rootIds.map((id) => result.nodes[id]!);
    expect(search).toMatchObject({ type: "path", fills: [{ type: "solid", color: "#123456" }] });
    expect(search!.strokes).toBeUndefined();
    expect(parseSvgPath(search!.path!)?.[0]).toEqual({ type: "M", x: 21.5, y: 16 });
    expect(parseSvgPath(flipped!.path!)?.[0]).toEqual({ type: "M", x: 26.5, y: 16 });
    expect(folder).toMatchObject({ type: "path", fills: [{ type: "solid", color: "#abcdef" }] });
    expect(folder!.path).not.toEqual(search!.path);
  });

  it("reports unsupported symbol weights and names without hiding other icons", async () => {
    const result = await importCanvasFile(
      "icons.pen",
      encoder.encode(
        JSON.stringify({
          children: [
            {
              type: "icon",
              id: "bold",
              library: "Material Symbols Rounded",
              icon: "check",
              weight: 700,
              width: 24,
              height: 24,
            },
            {
              type: "icon",
              id: "unknown",
              library: "Material Symbols Rounded",
              icon: "not_a_real_symbol",
              width: 24,
              height: 24,
            },
          ],
        }),
      ),
    );
    expect(result.rootIds.map((id) => result.nodes[id]!.type)).toEqual(["path", "rect"]);
    expect(result.warnings).toContain(
      "Material Symbols weights other than 400 were imported at weight 400",
    );
    expect(result.warnings).toContain(
      "Unsupported Material Symbols Rounded icons were imported as placeholders",
    );
  });

  it("centers path and line strokes by default while preserving explicit inside alignment", async () => {
    const result = await importCanvasFile(
      "strokes.pen",
      encoder.encode(
        JSON.stringify({
          children: [
            {
              type: "path",
              id: "grid",
              width: 40,
              height: 40,
              viewBox: [0, 0, 40, 40],
              geometry: "M10 0V40M20 0V40",
              stroke: "#ffffff",
              strokeWidth: 1,
            },
            { type: "line", id: "line", width: 40, height: 0, stroke: "#ffffff", strokeWidth: 1 },
            {
              type: "path",
              id: "box",
              width: 40,
              height: 40,
              geometry: "M0 0H40V40H0Z",
              stroke: { align: "inside", thickness: 2, fill: "#ffffff" },
            },
          ],
        }),
      ),
    );
    expect(result.warnings).toEqual([]);
    expect(result.rootIds.map((id) => result.nodes[id]!.strokes?.[0]?.align)).toEqual([
      "center",
      "center",
      "inside",
    ]);
  });

  it("preserves punctuation inside strings when removing comments and trailing commas", async () => {
    const content = 'hello,} and ,] plus an escaped "quote" and // literal';
    const result = await importCanvasFile(
      "punctuation.pen",
      encoder.encode(`// design
        {"children": [{"type": "text", "content": ${JSON.stringify(content)},
          "fontSize": 14, /* trailing property */ }, /* trailing child */ ], // trailing array
        }`),
    );
    expect(result.warnings).toEqual([]);
    expect(Object.values(result.nodes).map((node) => node.text?.content)).toEqual([content]);
  });

  it.each(["archive", "inline"])(
    "keeps image fills distinct between %s snapshot documents and deduplicates within each document",
    async (mode) => {
      const first = Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0,
        0, 2, 0, 0, 0, 3,
      ]);
      const second = first.slice();
      second[19] = 4;
      second[23] = 5;
      const sources = [first, second];
      const files: Record<string, Uint8Array> = {};
      for (const [index, bytes] of sources.entries()) {
        const url =
          mode === "inline"
            ? `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`
            : "image.png";
        files[`${index}/design.pen`] = encoder.encode(
          JSON.stringify({
            children: [0, 1].map((x) => ({
              type: "rectangle",
              x: x * 50,
              width: 40,
              height: 40,
              fill: { type: "image", url },
            })),
          }),
        );
        files[`${index}/image.png`] = bytes;
      }
      const result = await importCanvasFile("snapshot.zip", zipSync(files));
      expect(result.warnings).toEqual([]);
      expect(Object.values(result.assets).map((asset) => [asset.width, asset.height])).toEqual([
        [2, 3],
        [4, 5],
      ]);
      const paints = result.rootIds.map((id) =>
        result.nodes[id]!.childIds!.map((childId) => result.nodes[childId]!.fills![0]!),
      );
      expect(paints[0]![0]).toEqual(paints[0]![1]);
      expect(paints[1]![0]).toEqual(paints[1]![1]);
      expect(paints[0]![0]).not.toEqual(paints[1]![0]);
      expect(Object.values(result.assets).map((asset) => asset.url)).toEqual(
        sources.map((bytes) => `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`),
      );
    },
  );

  it.each(["archive", "inline"])("bounds image dimensions in %s fills", async (mode) => {
    const huge = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0,
      0x40, 1, 0, 0, 0, 2,
    ]);
    const source = encoder.encode(
      JSON.stringify({
        children: [
          {
            type: "rectangle",
            width: 20,
            height: 20,
            fill: {
              type: "image",
              url:
                mode === "inline"
                  ? `data:image/png;base64,${btoa(String.fromCharCode(...huge))}`
                  : "huge.png",
            },
          },
          { type: "rectangle", width: 10, height: 10, fill: "#ff0000" },
        ],
      }),
    );
    const result = await importCanvasFile(
      "design.zip",
      zipSync({ "design.pen": source, "huge.png": huge }),
    );
    expect(result.rootIds).toHaveLength(2);
    expect(Object.keys(result.assets)).toHaveLength(0);
    expect(result.nodes[result.rootIds[0]!]!.fills).toBeUndefined();
    expect(result.nodes[result.rootIds[1]!]!.fills).toEqual([{ type: "solid", color: "#ff0000" }]);
    expect(result.warnings).toContain(
      "Images must be at most 16384 px per side and 64 megapixels; resize the export first",
    );
  });

  it.each(["archive", "inline"])("sanitizes SVG image fills from %s sources", async (mode) => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="32" onload="alert(1)">' +
      '<title>café</title><script>alert(1)</script><rect width="24" height="32" fill="#ff0000"/>' +
      '<image href="https://example.com/image.png"/></svg>';
    const result = await importCanvasFile(
      "design.zip",
      zipSync({
        "design.pen": encoder.encode(
          JSON.stringify({
            children: [
              {
                type: "rectangle",
                width: 24,
                height: 32,
                fill: {
                  type: "image",
                  url:
                    mode === "inline"
                      ? `data:image/svg+xml,${encodeURIComponent(svg)}`
                      : "image.svg",
                },
              },
            ],
          }),
        ),
        "image.svg": encoder.encode(svg),
      }),
    );
    const asset = Object.values(result.assets)[0]!;
    expect(asset).toMatchObject({ mimeType: "image/svg+xml", width: 24, height: 32 });
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(asset.url.split(",")[1]!), (char) => char.charCodeAt(0)),
    );
    expect(decoded).toContain("café");
    expect(decoded).toContain('<rect width="24" height="32" fill="#ff0000"/>');
    expect(decoded).not.toMatch(/script|onload|https:\/\/example.com/);
    expect(result.warnings).toEqual([
      "SVG scripts, animation, embedded HTML, or external resources were removed; embed images and outline fonts before exporting for a faithful static image",
    ]);
  });

  it.each(["data:text/html,<script>alert(1)</script>", "data:image/png;base64,%%%%"])(
    "skips invalid inline image fills while preserving the node: %s",
    async (url) => {
      const result = await importCanvasFile(
        "inline.pen",
        encoder.encode(
          JSON.stringify({
            children: [{ type: "rectangle", width: 20, height: 20, fill: { type: "image", url } }],
          }),
        ),
      );
      expect(result.rootIds).toHaveLength(1);
      expect(result.assets).toEqual({});
      expect(result.nodes[result.rootIds[0]!]!.fills).toBeUndefined();
      expect(result.warnings).toEqual([
        "Some inline image fills are invalid or use an unsupported image format",
      ]);
    },
  );

  it("warns instead of throwing on files it cannot read", async () => {
    const result = await importCanvasFile("broken.pen", encoder.encode("{ not json"));
    expect(result.rootIds).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("evenOddToNonzero", () => {
  it("reverses nested subpaths so holes survive the nonzero rule", () => {
    const commands = parseSvgPath("M0 0L10 0L10 10L0 10ZM2 2L8 2L8 8L2 8Z")!;
    expect(serializePath(evenOddToNonzero(commands))).toBe(
      "M0 0L10 0L10 10L0 10ZM2 8L8 8L8 2L2 2Z",
    );
  });
});
