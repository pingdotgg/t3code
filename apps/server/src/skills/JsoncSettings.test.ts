import { describe, expect, it } from "@effect/vitest";

import { editJsoncText, parseJsonc, type JsoncChange } from "./JsoncSettings.ts";

const edit = (text: string, ...changes: JsoncChange[]) => {
  const result = editJsoncText(text, changes);
  if (result === undefined) return undefined;
  expect(parseJsonc(result).valid).toBe(true);
  return result;
};

describe("editJsoncText", () => {
  it("adds a key without touching comments, key order or trailing commas", () => {
    const text = '// top\n{\n  "a": 1, // one\n  /* two */ "b": {\n    "c": 2,\n  },\n}\n';
    const result = edit(text, { path: ["b", "d"], value: "x" });
    expect(result).toContain("// top");
    expect(result).toContain("// one");
    expect(result).toContain("/* two */");
    expect(parseJsonc(result ?? "").value).toEqual({ a: 1, b: { c: 2, d: "x" } });
  });

  it("indents with what the file uses", () => {
    expect(edit('{\n\t"a": 1\n}\n', { path: ["b"], value: 2 })).toContain('\t"b": 2');
    expect(edit('{\n    "a": 1\n}\n', { path: ["b"], value: 2 })).toContain('    "b": 2');
    expect(edit('{\r\n  "a": 1\r\n}\r\n', { path: ["b"], value: 2 })).toContain('\r\n  "b": 2');
  });

  it("removes the only key of an object that has a trailing comma without leaving a stray comma", () => {
    const text = '{\n  "a": 1,\n  "s": {\n    "x": "off",\n  },\n}\n';
    const result = edit(text, { path: ["s", "x"], value: undefined });
    expect(parseJsonc(result ?? "").value).toEqual({ a: 1 });
  });

  it("takes the objects and lists a removal emptied with it, but only those", () => {
    const text = '{\n  "p": { "s": { "x": "deny" }, "keep": 1 },\n  "q": { "r": { "y": 1 } }\n}\n';
    expect(parseJsonc(edit(text, { path: ["p", "s", "x"], value: undefined }) ?? "").value).toEqual(
      { p: { keep: 1 }, q: { r: { y: 1 } } },
    );
    expect(parseJsonc(edit(text, { path: ["q", "r", "y"], value: undefined }) ?? "").value).toEqual(
      { p: { s: { x: "deny" }, keep: 1 } },
    );
    expect(
      parseJsonc(edit('{ "l": ["a"] }', { path: ["l", 0], value: undefined }) ?? "").value,
    ).toEqual({});
  });

  it("changes nothing, and says so, when the value is already there", () => {
    const text = '{ "a": { "b": "x" } }';
    expect(edit(text, { path: ["a", "b"], value: "x" })).toBe(text);
    expect(edit(text, { path: ["a", "gone"], value: undefined })).toBe(text);
  });

  it("adds to the end of a list, creating the list when there is none", () => {
    expect(
      parseJsonc(edit('{ "l": ["a"] }', { path: ["l"], value: "b", insert: true }) ?? "").value,
    ).toEqual({ l: ["a", "b"] });
    expect(parseJsonc(edit("{}", { path: ["l"], value: "b", insert: true }) ?? "").value).toEqual({
      l: ["b"],
    });
  });

  it("removes list items last first, so positions keep their meaning", () => {
    const text = '{ "l": ["-a", "keep", "-b"] }';
    expect(
      parseJsonc(
        edit(text, { path: ["l", 2], value: undefined }, { path: ["l", 0], value: undefined }) ??
          "",
      ).value,
    ).toEqual({ l: ["keep"] });
  });

  it("refuses a path that runs through something that isn't an object or a list", () => {
    expect(
      edit('{ "permission": "allow" }', { path: ["permission", "skill", "x"], value: "deny" }),
    ).toBeUndefined();
    expect(edit('{ "l": {} }', { path: ["l"], value: "b", insert: true })).toBeUndefined();
    expect(
      edit('{ "skillOverrides": null }', { path: ["skillOverrides", "x"], value: "off" }),
    ).toBeUndefined();
  });
});

describe("parseJsonc", () => {
  it("reads like the agents: comments and trailing commas unless it is plain JSON", () => {
    const text = '{ // c\n "a": [1,], }';
    expect(parseJsonc(text).valid).toBe(true);
    expect(parseJsonc(text, true).valid).toBe(false);
    expect(parseJsonc('{ "a": 1 }', true).valid).toBe(true);
  });

  it("takes only an object at the top", () => {
    for (const text of ["[]", '"x"', "1", "", "{", '{ "a": }']) {
      expect(parseJsonc(text).valid).toBe(false);
    }
  });
});
