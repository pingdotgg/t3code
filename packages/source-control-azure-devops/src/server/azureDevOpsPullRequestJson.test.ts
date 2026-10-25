import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeItemContentJson,
  decodeIterationChangesJson,
  decodeIterationsJson,
  decodePullRequestJson,
  decodePullRequestListJson,
  decodeThreadsJson,
} from "./azureDevOpsPullRequestJson.ts";

const REST_URL =
  "https://dev.azure.com/acme/_apis/git/repositories/6f9c9b7f-0000-0000-0000-000000000000/pullRequests/42";

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pullRequestId: 42,
    title: "Add the change requests page",
    description: "Ships the page.",
    status: "active",
    isDraft: false,
    mergeStatus: "succeeded",
    createdBy: { displayName: "Bilal Hassan", uniqueName: "bilal@acme.dev" },
    sourceRefName: "refs/heads/feat/page",
    targetRefName: "refs/heads/main",
    creationDate: "2026-07-01T00:00:00Z",
    url: REST_URL,
    repository: { name: "web", project: { name: "platform" } },
    ...overrides,
  };
}

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

const asJson = (value: unknown) => JSON.stringify(value);

describe("decodePullRequestListJson", () => {
  it("reads a pull request as a change request", () => {
    const batch = expectSuccess(decodePullRequestListJson(asJson([pullRequest()])));

    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]).toMatchObject({
      number: 42,
      title: "Add the change requests page",
      author: { login: "bilal@acme.dev", name: "Bilal Hassan" },
      headBranch: "feat/page",
      baseBranch: "main",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
    });
  });

  it("assembles a browser url when Azure reports no web link", () => {
    const batch = expectSuccess(decodePullRequestListJson(asJson([pullRequest()])));

    expect(batch.items[0]?.url).toBe("https://dev.azure.com/acme/platform/_git/web/pullrequest/42");
  });

  it.each([
    ["completed", "merged"],
    ["something new", "open"],
  ])("reads the %s status as %s", (status, expected) => {
    const batch = expectSuccess(decodePullRequestListJson(asJson([pullRequest({ status })])));

    expect(batch.items[0]?.state).toBe(expected);
  });

  it.each([
    ["succeeded", "mergeable"],
    ["conflicts", "conflicting"],
    ["queued", "unknown"],
  ])("reads the %s merge status as %s", (mergeStatus, expected) => {
    const batch = expectSuccess(decodePullRequestListJson(asJson([pullRequest({ mergeStatus })])));

    expect(batch.items[0]?.mergeability).toBe(expected);
  });

  it("stands the closing time in for a last-touched time Azure does not keep", () => {
    const batch = expectSuccess(
      decodePullRequestListJson(
        asJson([pullRequest({ status: "completed", closedDate: "2026-07-05T00:00:00Z" })]),
      ),
    );

    expect(batch.items[0]).toMatchObject({
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-05T00:00:00Z",
    });
  });

  it("skips a malformed row but still counts it, so paging does not stop early", () => {
    const batch = expectSuccess(
      decodePullRequestListJson(asJson([{ pullRequestId: "nope" }, pullRequest()])),
    );

    expect(batch.items).toHaveLength(1);
    expect(batch.rawCount).toBe(2);
    expect(batch.rawIndexes).toEqual([1]);
  });
});

describe("decodePullRequestJson", () => {
  it("keeps the strategy stored with auto-complete", () => {
    const armed = expectSuccess(
      decodePullRequestJson(
        asJson(
          pullRequest({
            autoCompleteSetBy: { displayName: "Bilal Hassan" },
            completionOptions: { mergeStrategy: "squash" },
          }),
        ),
      ),
    );

    expect(armed).toMatchObject({ autoMergeEnabled: true, autoMergeMethod: "squash" });

    const unspecified = expectSuccess(
      decodePullRequestJson(
        asJson(
          pullRequest({
            autoCompleteSetBy: { displayName: "Bilal Hassan" },
            completionOptions: { squashMerge: false },
          }),
        ),
      ),
    );
    expect(unspecified?.autoMergeEnabled).toBe(true);
    expect(unspecified?.autoMergeMethod).toBeUndefined();
  });

  it("works out where the repository lives from what Azure returned", () => {
    const detail = expectSuccess(decodePullRequestJson(asJson(pullRequest())));

    expect(detail?.location).toEqual({ project: "platform", repository: "web" });
  });

  it("reports no repository location when Azure said too little to name one", () => {
    const detail = expectSuccess(
      decodePullRequestJson(
        asJson(
          pullRequest({
            url: null,
            repository: null,
            _links: {
              web: { href: "https://dev.azure.com/acme/platform/_git/web/pullrequest/42" },
            },
          }),
        ),
      ),
    );

    expect(detail?.location).toBeNull();
  });

  it("returns nothing when Azure gave no way to place the pull request at all", () => {
    const detail = expectSuccess(
      decodePullRequestJson(asJson(pullRequest({ url: null, repository: null }))),
    );

    expect(detail).toBeNull();
  });
});

describe("decodeThreadsJson", () => {
  it("takes every real comment of every thread, oldest first", () => {
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [
            {
              id: 2,
              comments: [
                {
                  id: 1,
                  content: "Second remark.",
                  author: { displayName: "Julius", uniqueName: "julius@acme.dev" },
                  publishedDate: "2026-07-03T00:00:00Z",
                },
              ],
            },
            {
              id: 1,
              comments: [
                { id: 1, content: "Bilal voted", commentType: "system", publishedDate: "x" },
                {
                  id: 2,
                  content: "First remark.",
                  author: { displayName: "Bilal", uniqueName: "bilal@acme.dev" },
                  publishedDate: "2026-07-02T00:00:00Z",
                },
              ],
            },
          ],
        }),
      ),
    );

    expect(comments.map((comment) => comment.body)).toEqual(["First remark.", "Second remark."]);
    expect(comments[0]).toMatchObject({
      kind: "issue-comment",
      author: { login: "bilal@acme.dev" },
    });
  });

  it("reads a thread pinned to a file as a review comment", () => {
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [
            {
              id: 3,
              threadContext: { filePath: "/src/app.ts" },
              comments: [{ id: 1, content: "Rename this.", publishedDate: "2026-07-02T00:00:00Z" }],
            },
          ],
        }),
      ),
    );

    expect(comments[0]).toMatchObject({ kind: "review-comment", path: "/src/app.ts" });
  });

  it("keeps the replies under a thread, which are as much of the conversation", () => {
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [
            {
              id: 4,
              threadContext: { filePath: "/src/app.ts" },
              comments: [
                { id: 1, content: "Rename this.", publishedDate: "2026-07-02T00:00:00Z" },
                { id: 2, content: "Renamed.", publishedDate: "2026-07-02T01:00:00Z" },
                { id: 3, content: "Thanks.", publishedDate: "2026-07-02T02:00:00Z" },
              ],
            },
          ],
        }),
      ),
    );

    expect(comments.map((comment) => comment.id)).toEqual(["4:1", "4:2", "4:3"]);
  });

  it("drops deleted threads and threads with nothing to show", () => {
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [
            {
              id: 1,
              isDeleted: true,
              comments: [{ id: 1, content: "gone", publishedDate: "2026-07-02T00:00:00Z" }],
            },
            { id: 2, comments: [] },
            {
              id: 3,
              comments: [{ id: 1, content: "   ", publishedDate: "2026-07-02T00:00:00Z" }],
            },
          ],
        }),
      ),
    );

    expect(comments).toEqual([]);
  });
});

describe("decodeIterationsJson", () => {
  const iteration = (id: number, head: string, base: string) => ({
    id,
    sourceRefCommit: { commitId: head },
    commonRefCommit: { commitId: base },
    targetRefCommit: { commitId: base },
  });

  it("reads every push in order, oldest first", () => {
    const iterations = expectSuccess(
      decodeIterationsJson(
        asJson({ value: [iteration(2, "bbb", "base"), iteration(1, "aaa", "base")] }),
      ),
    );

    expect(iterations.map((entry) => entry.id)).toEqual([1, 2]);
    expect(iterations.at(-1)).toEqual({ id: 2, headCommit: "bbb", mergeBaseCommit: "base" });
  });

  it("skips a push Azure could not place both ends of", () => {
    const iterations = expectSuccess(
      decodeIterationsJson(
        asJson({
          value: [{ id: 1, sourceRefCommit: { commitId: "aaa" } }, iteration(2, "bbb", "base")],
        }),
      ),
    );

    expect(iterations.map((entry) => entry.id)).toEqual([2]);
  });
});

describe("decodeIterationChangesJson", () => {
  it("names each changed file without the slash Azure leads its paths with", () => {
    const page = expectSuccess(
      decodeIterationChangesJson(
        asJson({
          changeEntries: [
            { changeType: "add", item: { path: "/DEMO.md", objectId: "ec00" } },
            {
              changeType: "edit",
              item: { path: "/README.md", objectId: "8f80", originalObjectId: "0ca4" },
            },
            { changeType: "delete", item: { path: "/OLD.md", originalObjectId: "1111" } },
          ],
        }),
      ),
    );

    expect(page.changes.map((change) => [change.path, change.changeKind])).toEqual([
      ["DEMO.md", "new"],
      ["README.md", "change"],
      ["OLD.md", "deleted"],
    ]);
  });

  it("keeps a space at the end of a file's name, which belongs to the name", () => {
    const page = expectSuccess(
      decodeIterationChangesJson(
        asJson({
          changeEntries: [
            { changeType: "edit", item: { path: "/docs/readme.md ", objectId: "ec00" } },
            {
              changeType: "rename",
              sourceServerItem: "/docs/old.md ",
              item: { path: "/docs/moved.md", objectId: "aaaa", originalObjectId: "aaaa" },
            },
          ],
        }),
      ),
    );

    expect(page.changes.map((change) => [change.path, change.oldPath])).toEqual([
      ["docs/readme.md ", "docs/readme.md "],
      ["docs/moved.md", "docs/old.md "],
    ]);
  });

  it("reads a rename as one file that moved, and says whether it also changed", () => {
    const page = expectSuccess(
      decodeIterationChangesJson(
        asJson({
          changeEntries: [
            {
              changeType: "rename",
              sourceServerItem: "/docs/old.md",
              item: { path: "/docs/new.md", objectId: "aaaa", originalObjectId: "aaaa" },
            },
            {
              changeType: "edit, rename",
              sourceServerItem: "/src/old.ts",
              item: { path: "/src/new.ts", objectId: "bbbb", originalObjectId: "cccc" },
            },
          ],
        }),
      ),
    );

    expect(page.changes).toEqual([
      {
        path: "docs/new.md",
        oldPath: "docs/old.md",
        changeKind: "rename-pure",
        objectId: "aaaa",
        originalObjectId: "aaaa",
      },
      {
        path: "src/new.ts",
        oldPath: "src/old.ts",
        changeKind: "rename-changed",
        objectId: "bbbb",
        originalObjectId: "cccc",
      },
    ]);
  });

  it("drops the folders Azure lists alongside the files that changed", () => {
    const page = expectSuccess(
      decodeIterationChangesJson(
        asJson({
          changeEntries: [
            { changeType: "add", item: { path: "/docs", isFolder: true, gitObjectType: "tree" } },
            { changeType: "add", item: { path: "/docs/page.md", objectId: "dddd" } },
          ],
        }),
      ),
    );

    expect(page.changes.map((change) => change.path)).toEqual(["docs/page.md"]);
  });

  it("reads where a rename came from out of either of the two places Azure names it", () => {
    const page = expectSuccess(
      decodeIterationChangesJson(
        asJson({
          changeEntries: [
            {
              changeType: "rename",
              originalPath: "/docs/old.md",
              item: { path: "/docs/new.md", objectId: "aaaa", originalObjectId: "aaaa" },
            },
          ],
        }),
      ),
    );

    expect(page.changes.at(0)?.oldPath).toBe("docs/old.md");
  });
});

describe("decodeItemContentJson", () => {
  it("reads an empty file as empty rather than as a failure to look", () => {
    expect(expectSuccess(decodeItemContentJson(asJson({ path: "/a.md" })))).toEqual({
      contents: "",
      isBinary: false,
    });
  });
});

describe("what az devops invoke answers with", () => {
  it("reads the envelope the extension adds its own continuation token to", () => {
    expect(
      expectSuccess(decodeThreadsJson(asJson({ value: [], count: 0, continuation_token: null }))),
    ).toEqual([]);

    expect(
      expectSuccess(
        decodeIterationsJson(
          asJson({
            count: 1,
            continuation_token: null,
            value: [
              {
                id: 1,
                sourceRefCommit: { commitId: "f4031105213c68f197cd46ea303bb5e72acc889a" },
                commonRefCommit: { commitId: "acbc805382edd6c38b8d6de6ba9f9bba9da4ad35" },
              },
            ],
          }),
        ),
      ),
    ).toEqual([
      {
        id: 1,
        headCommit: "f4031105213c68f197cd46ea303bb5e72acc889a",
        mergeBaseCommit: "acbc805382edd6c38b8d6de6ba9f9bba9da4ad35",
      },
    ]);
  });

  it("keeps the files of a change that names neither their object type nor their page after it", () => {
    const page = expectSuccess(
      decodeIterationChangesJson(
        asJson({
          continuation_token: null,
          changeEntries: [
            { changeType: "add", item: { path: "/DEMO.md", objectId: "EC005DB24" } },
            { changeType: "edit", item: { path: "/README.md", objectId: "8F8047A49" } },
          ],
        }),
      ),
    );

    expect(page.nextSkip).toBeNull();
    expect(page.changes).toEqual([
      {
        path: "DEMO.md",
        oldPath: "DEMO.md",
        changeKind: "new",
        objectId: "EC005DB24",
        originalObjectId: null,
      },
      {
        path: "README.md",
        oldPath: "README.md",
        changeKind: "change",
        objectId: "8F8047A49",
        originalObjectId: null,
      },
    ]);
  });

  it("reads a text file whose content type Azure calls a stream", () => {
    expect(
      expectSuccess(
        decodeItemContentJson(
          asJson({
            path: "/README.md",
            objectId: "8f8047a49",
            gitObjectType: "blob",
            content: "# T3Demo\n",
            contentMetadata: {
              contentType: "application/octet-stream",
              encoding: 65001,
              extension: "md",
              fileName: "README.md",
            },
            continuation_token: null,
          }),
        ),
      ),
    ).toEqual({ contents: "# T3Demo\n", isBinary: false });
  });
});
