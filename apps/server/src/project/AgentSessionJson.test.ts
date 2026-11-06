import { describe, expect, it } from "@effect/vitest";

import { createTranscriptJsonReader, TranscriptJsonLimitError } from "./AgentSessionJson.ts";

function read(
  json: string,
  size: number,
  select: (path: ReadonlyArray<string | number | null>) => boolean = () => true,
) {
  const reader = createTranscriptJsonReader(() => {}, select);
  for (let offset = 0; offset < json.length; offset += size)
    reader.write(json.slice(offset, offset + size));
  return reader.finish();
}

describe("transcript JSON projection", () => {
  it.each([1, 2, 7, 64, 1024])("matches JSON.parse across %i-character boundaries", (size) => {
    for (const text of [
      '{"a":1,"a":2,"b":"before","b":"after"}',
      '{"a":{"x":1},"a":{"y":2},"b":[],"c":{}}',
      '{"a":[null,true,false,1,-2.3e4,"😀\\u0061\\\\\\\"",{},[],[1,2]]}',
      '{"a":"s","a":null,"b":null,"b":"s","c":0,"c":false}',
      '{"__proto__":{"polluted":true},"constructor":1,"__proto__":2}',
    ])
      expect(read(text, size)).toEqual(JSON.parse(text));
  });

  it("projects siblings and array elements without merging repeated parent objects", () => {
    const text =
      '{"message":{"usage":{"input":100},"content":"large"},"message":{"usage":{"output":5},"content":[1,2]},"rows":[{"keep":1,"drop":2},{"keep":3}],"drop":{"keep":4}}';
    const projected = read(text, 1, (path) => {
      if (path[0] === "drop") return false;
      return !path.includes("content") && !path.includes("drop");
    });
    expect(projected).toEqual({
      message: { usage: { output: 5 } },
      rows: [{ keep: 1 }, { keep: 3 }],
    });
  });

  it.each(['{"a":', '{"a":1} trailing', '{"a":1}{"a":2}', '{"a":"bad\\x"}', '{"a":[1,]}'])(
    "rejects malformed input %s",
    (text) => {
      expect(read(text, 1)).toBeUndefined();
    },
  );

  it("retains the import allocation and depth limits", () => {
    const limited = createTranscriptJsonReader(
      () => {
        throw new TranscriptJsonLimitError({ message: "budget" });
      },
      () => true,
    );
    expect(() => limited.write('{"a":1}')).toThrow(TranscriptJsonLimitError);
    expect(() => read("[".repeat(129) + "0" + "]".repeat(129), 10)).toThrow(
      TranscriptJsonLimitError,
    );
  });

  it("streams top-level array records without retaining prior records", () => {
    const records: Array<unknown> = [];
    const reader = createTranscriptJsonReader(
      () => {},
      () => true,
      {
        onArrayItem: (index, value) => {
          records.push({ index, value });
          return true;
        },
      },
    );
    for (const char of '[{"nested":[1,2]},null,{"text":"😀"}]') reader.write(char);
    expect(reader.finish()).toEqual([]);
    expect(records).toEqual([
      { index: 0, value: { nested: [1, 2] } },
      { index: 1, value: null },
      { index: 2, value: { text: "😀" } },
    ]);
  });

  it("stops at a complete requested record and keeps original indices when skipping", () => {
    const records: Array<unknown> = [];
    const reader = createTranscriptJsonReader(
      () => {},
      (path) => path[0] !== 0,
      {
        onArrayItem: (index, value) => {
          records.push({ index, value });
          return index < 1;
        },
      },
    );
    reader.write('[{"skip":"first"},{"keep":2},{"later":3}]');
    expect(reader.stopped).toBe(true);
    reader.write("ignored");
    expect(records).toEqual([
      { index: 0, value: undefined },
      { index: 1, value: { keep: 2 } },
    ]);
  });
});
