import { Mesh, MeshPhongMaterial } from "three";
import { describe, expect, it } from "vite-plus/test";
import { parseFbxForTransfer } from "./fbxWorkerParser";
import { restoreModel } from "./modelTransfer";
import { disposeModel } from "./modelResources";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZMsAAAAASUVORK5CYII=";

function asciiFbx(embedded = false) {
  return new TextEncoder().encode(`; FBX 7.4.0 project file
FBXHeaderExtension: {
\tFBXVersion: 7400
}
Objects: {
\tGeometry: 1, "Geometry::Triangle", "Mesh" {
\t\tVertices: *9 {
\t\t\ta: 0,0,0,1,0,0,0,1,0
\t\t}
\t\tPolygonVertexIndex: *3 {
\t\t\ta: 0,1,-3
\t\t}
\t}
\tModel: 2, "Model::Triangle", "Mesh" {
\t\tVersion: 232
\t}
\tMaterial: 3, "Material::Leaves", "" {
\t\tShadingModel: "phong"
\t}
\tTexture: 4, "Texture::Leaves", "" {
\t\tFileName: "leaves.png"
\t}
\tVideo: 5, "Video::Leaves", "Clip" {
\t\tRelativeFilename: "leaves.png"
${embedded ? `\t\tContent: ,\n\t\t "${png}"\n` : ""}\t}
}
Connections: {
\tC: "OO",1,2
\tC: "OO",2,0
\tC: "OO",3,2
\tC: "OP",4,3,"DiffuseColor"
\tC: "OO",5,4
}
`).buffer;
}

// Minimal binary FBX fixture exercises raw embedded images through the real loader.
interface FbxNode {
  name: string;
  properties: (string | number | number[] | Uint8Array)[];
  children?: FbxNode[];
}
function binaryFbx() {
  const property = (value: FbxNode["properties"][number]) => {
    if (typeof value === "number") {
      const data = Buffer.alloc(9);
      data.write("L");
      data.writeBigInt64LE(BigInt(value), 1);
      return data;
    }
    if (Array.isArray(value)) {
      const data = Buffer.alloc(13 + value.length * 8);
      data.write("d");
      data.writeUInt32LE(value.length, 1);
      data.writeUInt32LE(value.length * 8, 9);
      value.forEach((entry, index) => data.writeDoubleLE(entry, 13 + index * 8));
      return data;
    }
    const raw = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    const prefix = Buffer.alloc(5);
    prefix.write(typeof value === "string" ? "S" : "R");
    prefix.writeUInt32LE(raw.length, 1);
    return Buffer.concat([prefix, raw]);
  };
  const node = (value: FbxNode, offset: number): Buffer => {
    const name = Buffer.from(value.name);
    const properties = Buffer.concat(value.properties.map(property));
    const children: Buffer[] = [];
    let endOffset = offset + 13 + name.length + properties.length;
    for (const child of value.children ?? []) {
      const data = node(child, endOffset);
      children.push(data);
      endOffset += data.length;
    }
    if (children.length) {
      children.push(Buffer.alloc(13));
      endOffset += 13;
    }
    const header = Buffer.alloc(13);
    header.writeUInt32LE(endOffset, 0);
    header.writeUInt32LE(value.properties.length, 4);
    header.writeUInt32LE(properties.length, 8);
    header.writeUInt8(name.length, 12);
    return Buffer.concat([header, name, properties, ...children]);
  };
  const objects: FbxNode = {
    name: "Objects",
    properties: [],
    children: [
      {
        name: "Geometry",
        properties: [1, "Triangle", "Mesh"],
        children: [
          { name: "Vertices", properties: [[0, 0, 0, 1, 0, 0, 0, 1, 0]] },
          { name: "PolygonVertexIndex", properties: [[0, 1, -3]] },
        ],
      },
      { name: "Model", properties: [2, "Triangle", "Mesh"] },
      {
        name: "Material",
        properties: [3, "Leaves", ""],
        children: [{ name: "ShadingModel", properties: ["phong"] }],
      },
      {
        name: "Texture",
        properties: [4, "Leaves", ""],
        children: [{ name: "FileName", properties: ["leaves.png"] }],
      },
      {
        name: "Video",
        properties: [5, "Leaves", "Clip"],
        children: [
          { name: "RelativeFilename", properties: ["leaves.png"] },
          { name: "Content", properties: [new Uint8Array(Buffer.from(png, "base64"))] },
        ],
      },
    ],
  };
  const connections: FbxNode = {
    name: "Connections",
    properties: [],
    children: [
      ["OO", 1, 2],
      ["OO", 2, 0],
      ["OO", 3, 2],
      ["OP", 4, 3, "DiffuseColor"],
      ["OO", 5, 4],
    ].map((properties) => ({ name: "C", properties: properties as (string | number)[] })),
  };
  const header = Buffer.alloc(27);
  header.write("Kaydara FBX Binary  \0\x1a\0", 0, "binary");
  header.writeUInt32LE(7400, 23);
  const objectBytes = node(objects, 27);
  const bytes = Buffer.concat([
    header,
    objectBytes,
    node(connections, 27 + objectBytes.length),
    Buffer.alloc(176),
  ]);
  return new Uint8Array(bytes).buffer;
}

describe("worker FBX parsing without a DOM", () => {
  it("parses real geometry and defers external textures", async () => {
    const { payload, transfer } = await parseFbxForTransfer(
      asciiFbx(),
      "https://host.test/assets/",
    );
    expect(payload.images[0]!.url).toBe("https://host.test/assets/leaves.png");
    const { model } = restoreModel(structuredClone(payload, { transfer }));
    const mesh = model.children[0] as Mesh;
    expect(mesh.geometry.attributes.position!.count).toBe(3);
    expect((mesh.material as MeshPhongMaterial).map!.image).toBeNull();
    disposeModel(model);
  });

  it("preserves ASCII embedded image data", async () => {
    const { payload } = await parseFbxForTransfer(asciiFbx(true), "https://host.test/assets/");
    expect(payload.images[0]!.url).toBe(`data:image/png;base64,${png}`);
  });

  it("sends binary embedded image bytes instead of worker-owned blob URLs", async () => {
    const { payload } = await parseFbxForTransfer(binaryFbx(), "https://host.test/assets/");
    const blob = payload.images[0]!.url as Blob;
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array(Buffer.from(png, "base64")),
    );
    expect(payload.geometries[0]!.attributes.position!.array.length).toBe(9);
  });

  it("reports invalid FBX data", async () => {
    await expect(
      parseFbxForTransfer(new TextEncoder().encode("invalid").buffer, ""),
    ).rejects.toThrow();
  });
});
