import { describe, expect, it } from "vite-plus/test";

import { buildZip } from "./testing/zipFixture.ts";
import { expandMesh } from "./testing/meshFixture.ts";
import { parseThreeMf as parse } from "./threeMfMesh.ts";

const parseThreeMf = async (...args: Parameters<typeof parse>) => expandMesh(await parse(...args));

const LIMITS = { maxTriangles: 1000 };
const signal = new AbortController().signal;

const TRIANGLE = `<mesh><vertices>
  <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh>`;

function model(resources: string, build: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
<resources>${resources}</resources><build>${build}</build></model>`;
}

const RELS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/main.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

describe("parseThreeMf", () => {
  it("places build items and nested components with their transforms", async () => {
    const bytes = await buildZip({
      "_rels/.rels": { text: RELS },
      "3D/main.model": {
        deflate: true,
        text: model(
          `<object id="1">${TRIANGLE}</object>
           <object id="2"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 5"/></components></object>`,
          `<item objectid="2" transform="2 0 0 0 2 0 0 0 2 10 0 0"/><item objectid="1"/>`,
        ),
      },
    });
    const positions = await parseThreeMf(bytes, LIMITS, signal);
    // The component lifts z by 5, then the item doubles everything and moves x by 10.
    expect([...positions!.subarray(0, 9)]).toEqual([10, 0, 10, 12, 0, 10, 10, 2, 10]);
    expect([...positions!.subarray(9, 18)]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it("follows components into other model parts", async () => {
    const bytes = await buildZip({
      "3D/3dmodel.model": {
        text: model(
          `<object id="5"><components><p:component objectid="1" p:path="/3D/Objects/part.model"/></components></object>`,
          `<item objectid="5"/>`,
        ),
      },
      "3D/Objects/part.model": {
        deflate: true,
        text: model(`<object id="1">${TRIANGLE}</object>`, ""),
      },
    });
    expect((await parseThreeMf(bytes, LIMITS, signal))?.length).toBe(9);
  });

  it("shows top-level objects when the build is empty, and rejects other data", async () => {
    const bytes = await buildZip({
      "3D/3dmodel.model": {
        text: model(
          `<object id="1">${TRIANGLE}</object><object id="2"><components><component objectid="1"/></components></object>`,
          "",
        ),
      },
    });
    expect((await parseThreeMf(bytes, LIMITS, signal))?.length).toBe(9);
    expect(
      await parseThreeMf(await buildZip({ "a.txt": { text: "a" } }), LIMITS, signal),
    ).toBeNull();
    expect(await parseThreeMf(new TextEncoder().encode("solid"), LIMITS, signal)).toBeNull();
    // Each level fans out to the next ten times: a few kilobytes describing 10^8 placements.
    const fanOut = Array.from(
      { length: 8 },
      (_, level) =>
        `<object id="${level + 1}"><components>${`<component objectid="${level + 2}"/>`.repeat(10)}</components></object>`,
    ).join("");
    const bomb = await buildZip({
      "3D/3dmodel.model": {
        text: model(`${fanOut}<object id="9">${TRIANGLE}</object>`, `<item objectid="1"/>`),
      },
    });
    expect(await parseThreeMf(bomb, { maxTriangles: 1e9 }, signal)).toBeNull();
  });
});
