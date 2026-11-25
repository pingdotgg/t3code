import { describe, expect, it } from "vite-plus/test";
import { readOmpForm } from "./form.ts";
import { readOmpQueueRecovery } from "./queueRecovery.ts";

describe("OMP form projection", () => {
  it("projects inert controls and sends native values without exposing passwords or hidden fields", () => {
    const form = readOmpForm(`
      <form action="https://example.invalid" onsubmit="ignored()">
        <h1>Configuration</h1>
        <script>ignored()</script>
        <input type="hidden" name="context" value="hidden-fixture">
        <label>Key<input name="key" type="password" value="private-default" required></label>
        <label for="count">Count</label><input id="count" name="count" type="number" min="1" required>
        <select name="mode"><option value="x" disabled>X</option><option value="y">Y</option></select>
        <fieldset><legend>Extras</legend>
          <label><input type="checkbox" name="extras" value="a" checked>Follow A</label>
          <label><input type="checkbox" name="extras" value="b">Follow B</label>
        </fieldset>
        <textarea name="notes">line 1\nline 2</textarea>
      </form>`)!;
    expect(form.title).toBe("Configuration");
    expect(JSON.stringify(form.fields)).not.toMatch(
      /hidden-fixture|private-default|ignored\(\)|example\.invalid/,
    );
    expect(form.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "key", label: "Key", secret: true, required: true }),
        expect.objectContaining({ name: "count", label: "Count" }),
        expect.objectContaining({ name: "mode", initialChoices: ["y"] }),
        expect.objectContaining({
          name: "extras",
          label: "Extras",
          multiple: true,
          initialChoices: ["a"],
        }),
        expect.objectContaining({ name: "notes", multiline: true, initialValue: "line 1\nline 2" }),
      ]),
    );
    const values = { key: " fixture ", count: "2", mode: ["y"], extras: ["a", "b"], notes: "ok" };
    expect(form.response(values)).toEqual({ data: { ...values, mode: "y" } });
    for (const change of [
      { count: "0" },
      { count: "oops" },
      { mode: ["x"] },
      { key: "" },
      { unexpected: "item" },
    ]) {
      expect(form.response({ ...values, ...change })).toBeUndefined();
    }
  });
});

describe("OMP queue recovery", () => {
  it("keeps steering and follow-ups in wire order and reports unavailable images and truncation", () => {
    const result = readOmpQueueRecovery({
      steering: [{ text: "first", images: [{ mimeType: "image/png", data: "AQID" }] }],
      followUp: [
        { text: "second", images: [{ mimeType: "image/svg+xml", data: "AQID" }] },
        { text: "third" },
      ],
      truncated: true,
    });
    expect(result.entries.map((entry) => entry.text)).toEqual(["first", "second", "third"]);
    expect(result.entries[0]?.images[0]).toEqual({
      mimeType: "image/png",
      name: "omp-1-1.png",
      bytes: Buffer.from([1, 2, 3]),
    });
    expect(result.entries[1]?.images).toEqual([]);
    expect(result).toMatchObject({ imagesDropped: true, truncated: true });
  });
});
