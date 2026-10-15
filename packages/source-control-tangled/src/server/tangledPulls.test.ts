import { assert, describe, it } from "@effect/vitest";

import { numberPulls, offsetFromRows, parsePullPageRows } from "./tangledPulls.ts";
import type { TangledPull } from "./tangledPulls.ts";

const pull = (rkey: string, title: string): TangledPull => ({
  rkey,
  title,
  state: "open",
  createdAt: "2026-05-18T10:34:32Z",
});

describe("numberPulls", () => {
  it("places pull requests in the order tangled.org numbered them", () => {
    // Record keys are time-sortable, so this order is the host's creation order whatever
    // order `tg pr list` answered in.
    const numbered = numberPulls([
      pull("3mm4efxfkov22", "third"),
      pull("3lydhsmxfli22", "first"),
      pull("3mkaewigwhi22", "second"),
    ]);
    assert.deepStrictEqual(
      numbered.map((entry) => [entry.index, entry.pull.title]),
      [
        [1, "first"],
        [2, "second"],
        [3, "third"],
      ],
    );
  });
});

describe("offsetFromRows", () => {
  // Six pull requests, numbered so the rows below all imply an offset of 11.
  const pulls = numberPulls(
    [
      "3m6bb2zk52i22",
      "3m7cstxe6ee22",
      "3mcaaaaaaaa22",
      "3mdbbbbbbbb22",
      "3mcccccccc22",
      "3mhhhn33dsu22",
    ].map((rkey, at) => pull(rkey, `title ${at + 1}`)),
  );

  it("reads one offset that every matched row agrees on", () => {
    // index 1 -> #12, index 3 -> #14, index 6 -> #17; all three say +11.
    assert.strictEqual(
      offsetFromRows(
        [
          { number: 12, title: "title 1" },
          { number: 14, title: "title 3" },
          { number: 17, title: "title 6" },
        ],
        pulls,
      ),
      11,
    );
  });

  it("reads nothing from a single row that is not the newest, which is a guess", () => {
    assert.strictEqual(offsetFromRows([{ number: 12, title: "title 1" }], pulls), null);
  });

  it("takes a single row when it anchors the newest pull request", () => {
    // A repository whose page shows one row: nothing `tg` omits can sit after the newest, so
    // that row's offset cannot be shifted. This is what small repositories look like.
    assert.strictEqual(offsetFromRows([{ number: 17, title: "title 6" }], pulls), 11);
  });

  it("reads nothing when the rows imply different offsets", () => {
    assert.strictEqual(
      offsetFromRows(
        [
          { number: 12, title: "title 1" },
          { number: 99, title: "title 6" },
        ],
        pulls,
      ),
      null,
    );
  });

  it("numbers separate PRs with the same title without matching both to the first record", () => {
    const repeated = numberPulls([
      pull("a", "First"),
      pull("b", "Second"),
      pull("c", "Same title"),
      pull("d", "Same title"),
    ]);
    assert.strictEqual(
      offsetFromRows(
        [
          { number: 4, title: "Same title" },
          { number: 3, title: "Same title" },
          { number: 2, title: "Second" },
          { number: 1, title: "First" },
        ],
        repeated,
      ),
      0,
    );
  });

  it("resolves repeated titles only when the rows identify one common offset", () => {
    const repeated = numberPulls([pull("a", "Same"), pull("b", "Same")]);
    assert.strictEqual(
      offsetFromRows(
        [
          { number: 7, title: "Same" },
          { number: 8, title: "Same" },
        ],
        repeated,
      ),
      6,
    );
    assert.strictEqual(offsetFromRows([{ number: 8, title: "Same" }], repeated), null);
  });

  it("reads nothing when no row matches a pull request", () => {
    assert.strictEqual(
      offsetFromRows(
        [
          { number: 3, title: "something else" },
          { number: 4, title: "another thing" },
        ],
        pulls,
      ),
      null,
    );
  });

  it("ignores rows that do not match without giving up on the rows that do", () => {
    assert.strictEqual(
      offsetFromRows(
        [
          { number: 3, title: "something else" },
          { number: 12, title: "title 1" },
          { number: 17, title: "title 6" },
        ],
        pulls,
      ),
      11,
    );
  });
});

describe("parsePullPageRows", () => {
  it("decodes title character references so numbered reads match the CLI title", () => {
    const title = "Fix <tag> & \"parsing\" 'quotes' 🚀 &lt;";
    const html =
      '<a href="/alice.example/repo/pulls/1">Fix &lt;tag&gt; &amp; &#34;parsing&#34; &#x27;quotes&#x27; &#x1F680; &amp;lt; <span>#1</span></a>';
    const rows = parsePullPageRows(html, "alice.example/repo");
    assert.deepStrictEqual(rows, [{ number: 1, title }]);
    assert.strictEqual(offsetFromRows(rows, numberPulls([pull("a", title)])), 0);
  });

  it("reads the number and title a tangled.org page prints", () => {
    const html = `
      <a href="/tangled.org/knot-docker/pulls/19" class="dark:text-white">
        build(docker): automatically use latest tag
        <span class="text-gray-500 dark:text-gray-400">#19</span>
      </a>
      <a href="/tangled.org/knot-docker/pulls/18" class="dark:text-white">
        slim down image size <span>#18</span>
      </a>`;
    assert.deepStrictEqual(parsePullPageRows(html, "tangled.org/knot-docker"), [
      { number: 19, title: "build(docker): automatically use latest tag" },
      { number: 18, title: "slim down image size" },
    ]);
  });

  it("reads nothing from a page without pull request rows", () => {
    assert.deepStrictEqual(parsePullPageRows("<html><body>nothing</body></html>", "a/b"), []);
  });

  it("does not read another repository's rows", () => {
    const html = `<a href="/other/repo/pulls/4">elsewhere</a>`;
    assert.deepStrictEqual(parsePullPageRows(html, "tangled.org/knot-docker"), []);
  });
});
