import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import { decodeIssueNotesJson } from "./gitLabIssueJson.ts";

describe("decodeIssueNotesJson", () => {
  it.each([
    [
      "HTML partial addition",
      '<p>changed title from <code class="idiff">Fix login</code> to <code class="idiff">Fix login<span class="idiff left right addition"> on Linux</span></code></p>',
      "Fix login on Linux",
    ],
    [
      "HTML several runs",
      '<p>changed title from <code class="idiff"><span class="idiff left deletion">Old</span> title <span class="idiff right deletion">v1</span></code> to <code class="idiff"><span class="idiff left addition">New</span> title <span class="idiff right addition">v2</span></code></p>',
      "New title v2",
    ],
    [
      "HTML entities",
      '<p>changed title from <code class="idiff">Fix</code> to <code class="idiff">Fix<span class="idiff left right addition"> &quot;a&quot; &#39;b&#39; &amp; &lt;b&gt; &amp;lt;c&amp;gt;</span></code></p>',
      `Fix "a" 'b' & <b> &lt;c&gt;`,
    ],
    [
      "legacy partial addition",
      "changed title from **Fix login** to **Fix login{+ on Linux+}**",
      "Fix login on Linux",
    ],
    [
      "legacy pure deletion",
      "changed title from **Fix login{- bug-}** to **Fix login**",
      "Fix login",
    ],
    [
      "legacy several runs",
      "changed title from **{-Old-} title {-v1-}** to **{+New+} title {+v2+}**",
      "New title v2",
    ],
    [
      "legacy title containing to",
      "changed title from **Move A to B** to **Move A to {+C+}**",
      "Move A to C",
    ],
    [
      "legacy deleted run containing to",
      "changed title from **{-A ** to ** B-}** to **{+New+}**",
      "New",
    ],
    ["legacy new title with marker text", "changed title from **{-A-}** to **{+{-x-}+}**", "{-x-}"],
    ["legacy malformed deletion runs", `changed title from **${"{-x-}".repeat(40)}**`, null],
  ])("decodes a title change note (%s) into a renamed event", (_label, body, expected) => {
    const decoded = decodeIssueNotesJson(
      JSON.stringify([
        {
          id: 1,
          body,
          author: { username: "theo" },
          created_at: "2026-07-03T00:00:00Z",
          system: true,
        },
      ]),
    );
    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    expect(decoded.success.events.map((event) => [event.kind, event.detail])).toEqual([
      ["renamed", expected],
    ]);
  });
});
