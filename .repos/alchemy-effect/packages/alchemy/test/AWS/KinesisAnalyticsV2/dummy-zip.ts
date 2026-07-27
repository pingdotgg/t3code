/**
 * Deterministically builds minimal, structurally valid zip archives —
 * enough for CreateApplication's ZIPFILE code validation (which requires a
 * `.jar` entry inside the uploaded zip) without a real Flink build. The
 * application is never started in ungated tests; a start with this
 * placeholder would fail job submission.
 */

const crc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array | string;
}

export const makeZip = (entries: ReadonlyArray<ZipEntry>): Uint8Array => {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const body =
      typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(body);

    const localHeader = new Uint8Array(30 + name.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true); // local file header signature
    localView.setUint16(4, 20, true); // version needed to extract
    localView.setUint16(8, 0, true); // compression method: STORED
    localView.setUint32(14, crc, true);
    localView.setUint32(18, body.length, true); // compressed size
    localView.setUint32(22, body.length, true); // uncompressed size
    localView.setUint16(26, name.length, true);
    localHeader.set(name, 30);

    const centralHeader = new Uint8Array(46 + name.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true); // central directory signature
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed to extract
    centralView.setUint16(10, 0, true); // compression method: STORED
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, body.length, true);
    centralView.setUint32(24, body.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true); // local header offset
    centralHeader.set(name, 46);

    chunks.push(localHeader, body);
    centralChunks.push(centralHeader);
    offset += localHeader.length + body.length;
  }

  const centralSize = centralChunks.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true); // end of central directory
  eocdView.setUint16(8, entries.length, true); // entries on this disk
  eocdView.setUint16(10, entries.length, true); // total entries
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  const zip = new Uint8Array(offset + centralSize + eocd.length);
  let cursor = 0;
  for (const chunk of [...chunks, ...centralChunks, eocd]) {
    zip.set(chunk, cursor);
    cursor += chunk.length;
  }
  return zip;
};

/**
 * A zip whose single entry is `app.jar` — itself a structurally valid
 * (empty) jar with a manifest.
 */
export const makeDummyFlinkCodeZip = (): Uint8Array => {
  const jar = makeZip([
    { name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\r\n\r\n" },
  ]);
  return makeZip([{ name: "app.jar", data: jar }]);
};
