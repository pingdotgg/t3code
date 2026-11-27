import { describe, expect, it } from "@effect/vitest";

import { parseNote, serializeNote } from "./botNotes.ts";

describe("bot notes", () => {
  it("round-trips a note, flattening header values to one line", () => {
    const text = serializeNote({
      title: "Release\nplan",
      summary: "What ships  in 2.1",
      body: "- tag on Friday",
    });
    expect(parseNote("release", text)).toEqual({
      title: "Release plan",
      summary: "What ships in 2.1",
      body: "- tag on Friday\n",
    });
  });

  it("reads a hand-written file without a header as body, titled by its slug", () => {
    expect(parseNote("scratch", "# Ideas\n---\nnot a header\n")).toEqual({
      title: "scratch",
      summary: "",
      body: "# Ideas\n---\nnot a header\n",
    });
  });
});
