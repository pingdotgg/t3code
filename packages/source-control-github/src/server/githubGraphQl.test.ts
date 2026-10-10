import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { aliasedGraphQlDocument, readGraphQlPages } from "./githubGraphQl.ts";

describe("aliasedGraphQlDocument", () => {
  it("keeps every value out of the document, each under its alias's own variable", () => {
    const document = aliasedGraphQlDocument({
      operation: "query",
      name: "Lookups",
      alias: "s",
      items: ['acme") { x } #', "web"],
      shared: { owner: ["String!", "acme"] },
      variables: (repo) => ({ name: ["String!", repo] }),
      field: ({ name }) => `repository(owner: $owner, name: ${name}) { id }`,
    });
    assert.isNotNull(document);
    expect(document!.query).toBe(
      "query Lookups($owner: String!, $s0_name: String!, $s1_name: String!) {\n" +
        "  s0: repository(owner: $owner, name: $s0_name) { id }\n" +
        "  s1: repository(owner: $owner, name: $s1_name) { id }\n}",
    );
    expect(document!.variables).toEqual({
      owner: "acme",
      s0_name: 'acme") { x } #',
      s1_name: "web",
    });
  });

  it("aliases by key and nests inside a shared parent when asked", () => {
    const document = aliasedGraphQlDocument({
      operation: "query",
      alias: "pr",
      key: (number) => number,
      items: [2, 3],
      variables: (number) => ({ number: ["Int!", number] }),
      field: ({ number }) => `pullRequest(number: ${number}) { id }`,
      within: (fields) => `repository(owner: "a", name: "b") {\n${fields}\n}`,
    });
    expect(document?.query).toContain("  pr2: pullRequest(number: $pr2_number) { id }");
    expect(document?.query).toContain("  pr3: pullRequest(number: $pr3_number) { id }");
    expect(document?.variables).toEqual({ pr2_number: 2, pr3_number: 3 });
  });

  it("asks for nothing when there is nothing to ask", () => {
    expect(
      aliasedGraphQlDocument({
        operation: "mutation",
        alias: "f",
        items: [],
        variables: () => ({}),
        field: () => "x",
      }),
    ).toBeNull();
  });
});

describe("readGraphQlPages", () => {
  const pages = (cursors: ReadonlyArray<string | null>) => {
    const asked: Array<string | null> = [];
    const read = (after: string | null) =>
      Effect.sync(() => {
        asked.push(after);
        return { next: cursors[asked.length - 1] ?? null };
      });
    return { asked, read };
  };

  it.effect("follows the cursor until GitHub has no more", () =>
    Effect.gen(function* () {
      const { asked, read } = pages(["a", "b", null]);
      const result = yield* readGraphQlPages(read, { nextCursor: (page) => page.next });
      expect(asked).toEqual([null, "a", "b"]);
      expect(result.truncated).toBe(false);
    }),
  );

  it.effect("stops as truncated at the page limit, at `until`, or on a repeated cursor", () =>
    Effect.gen(function* () {
      const limited = pages(["a", "b", "c"]);
      const atLimit = yield* readGraphQlPages(limited.read, {
        nextCursor: (page) => page.next,
        maxPages: 2,
      });
      expect(limited.asked).toEqual([null, "a"]);
      expect(atLimit.truncated).toBe(true);

      const enough = pages(["a", "b", "c"]);
      const satisfied = yield* readGraphQlPages(enough.read, {
        nextCursor: (page) => page.next,
        until: (read) => read.length === 1,
      });
      expect(enough.asked).toEqual([null]);
      expect(satisfied.truncated).toBe(true);

      const stuck = pages(["a", "a", "a"]);
      const repeated = yield* readGraphQlPages(stuck.read, {
        nextCursor: (page) => page.next,
        from: "start",
      });
      expect(stuck.asked).toEqual(["start", "a"]);
      expect(repeated.truncated).toBe(true);
    }),
  );
});
