export function fontFixture(
  options: {
    family?: string;
    typographicFamily?: string;
    weight?: number;
    italic?: boolean;
    variable?: boolean;
  } = {},
) {
  const records = [
    { id: 1, value: options.family ?? "Legacy Family" },
    ...(options.typographicFamily ? [{ id: 16, value: options.typographicFamily }] : []),
  ];
  const strings = records.map((record) => {
    const bytes = new Uint8Array(record.value.length * 2);
    const view = new DataView(bytes.buffer);
    [...record.value].forEach((_, index) =>
      view.setUint16(index * 2, record.value.charCodeAt(index)),
    );
    return bytes;
  });
  const nameLength =
    6 + records.length * 12 + strings.reduce((sum, string) => sum + string.length, 0);
  const tables = [
    { tag: "name", length: nameLength },
    { tag: "OS/2", length: 64 },
    ...(options.variable ? [{ tag: "fvar", length: 16 }] : []),
  ];
  const data = new Uint8Array(
    12 + tables.length * 16 + tables.reduce((sum, table) => sum + table.length, 0),
  );
  const view = new DataView(data.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, tables.length);
  let offset = 12 + tables.length * 16;
  for (const [index, table] of tables.entries()) {
    const entry = 12 + index * 16;
    for (let k = 0; k < 4; k++) data[entry + k] = table.tag.charCodeAt(k);
    view.setUint32(entry + 8, offset);
    view.setUint32(entry + 12, table.length);
    if (table.tag === "name") {
      view.setUint16(offset + 2, records.length);
      view.setUint16(offset + 4, 6 + records.length * 12);
      let relative = 0;
      for (const [i, record] of records.entries()) {
        const start = offset + 6 + i * 12;
        view.setUint16(start, 3);
        view.setUint16(start + 2, 1);
        view.setUint16(start + 4, 0x409);
        view.setUint16(start + 6, record.id);
        view.setUint16(start + 8, strings[i]!.length);
        view.setUint16(start + 10, relative);
        data.set(strings[i]!, offset + 6 + records.length * 12 + relative);
        relative += strings[i]!.length;
      }
    } else if (table.tag === "OS/2") {
      view.setUint16(offset + 4, options.weight ?? 400);
      view.setUint16(offset + 62, options.italic ? 1 : 0);
    }
    offset += table.length;
  }
  return data;
}
