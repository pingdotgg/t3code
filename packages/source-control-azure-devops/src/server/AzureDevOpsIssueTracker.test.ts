import { describe, expect, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { VcsProcessExitError } from "@t3tools/contracts";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsIssueTracker from "./AzureDevOpsIssueTracker.ts";
import {
  decodeCommentsJson,
  decodeWorkItemJson,
  decodeWorkItemsJson,
  pullRequestNumberOf,
} from "./azureDevOpsIssueJson.ts";

const encode = (value: unknown) => JSON.stringify(value);

const WORK_ITEM = {
  id: 7,
  rev: 2,
  url: "https://dev.azure.com/acme/_apis/wit/workItems/7",
  fields: {
    "System.Title": "Composer loses focus",
    "System.State": "Resolved",
    "System.CreatedDate": "2026-07-01T00:00:00Z",
    "System.ChangedDate": "2026-07-03T00:00:00Z",
    "Microsoft.VSTS.Common.ClosedDate": "2026-07-03T00:00:00Z",
    "System.CreatedBy": { uniqueName: "octo@acme.test", displayName: "Octo Cat" },
    "System.AssignedTo": "Theo <theo@acme.test>",
    "System.Tags": "bug; ui; bug",
    "System.TeamProject": "Web App",
    "System.CommentCount": 2,
    "System.Description": "<p>Typing drops focus.</p>",
  },
  relations: [
    { rel: "ArtifactLink", url: "vstfs:///Git/PullRequestId/p-guid%2Fr-guid%2F50" },
    { rel: "System.LinkTypes.Related", url: "https://dev.azure.com/acme/_apis/wit/workItems/8" },
  ],
};

const requestBodies = new WeakMap<
  ReadonlyArray<string>,
  { ids: number[]; fields?: string[]; asOf?: string; $expand?: string }
>();
const patchBodies = new WeakMap<
  ReadonlyArray<string>,
  ReadonlyArray<{ method: string; uri: string; headers: Record<string, string>; body: unknown }>
>();

function readBatch(args: ReadonlyArray<string>) {
  return args.includes("workitemsbatch") ? (requestBodies.get(args) ?? null) : null;
}

function nativeResponse(args: ReadonlyArray<string>, raw: string) {
  const value = JSON.parse(raw);
  if (args.includes("workitemsbatch") && typeof value.id === "number")
    return encode({ count: 1, value: [value] });
  if (args.includes("batch") && typeof value.id === "number")
    return encode({ count: 1, value: [{ code: 200 }] });
  return raw;
}

/** Every `az` command the detail read runs, told apart by its first few arguments. */
function answer(args: ReadonlyArray<string>): string {
  const resource = args[args.indexOf("--resource") + 1];
  if (args[0] === "boards" || (readBatch(args)?.ids.length === 1 && readBatch(args)?.ids[0] === 7))
    return encode(WORK_ITEM);
  if (args[0] === "repos") {
    return encode({
      pullRequestId: 50,
      title: "fix(web): keep composer focus",
      status: "completed",
      isDraft: false,
      sourceRefName: "refs/heads/fix",
      targetRefName: "refs/heads/main",
      creationDate: "2026-07-02T00:00:00Z",
      closedDate: "2026-07-03T00:00:00Z",
      mergeStatus: "succeeded",
      repository: {
        id: "r-guid",
        name: "web",
        webUrl: "https://dev.azure.com/acme/Web%20App/_git/web",
        project: { id: "p-guid", name: "Web App" },
      },
      createdBy: { uniqueName: "theo@acme.test", displayName: "Theo" },
      description: "",
      reviewers: [],
      _links: { web: { href: "https://dev.azure.com/acme/Web%20App/_git/web/pullrequest/50" } },
    });
  }
  if (resource === "comments") {
    return encode({
      continuationToken: "next-token",
      comments: [
        {
          id: 1,
          text: "Repro attached.",
          format: "markdown",
          createdDate: "2026-07-02T00:00:00Z",
          createdBy: { uniqueName: "julius@acme.test", displayName: "Julius" },
          reactions: [
            { type: "like", count: 2, isCurrentUserEngaged: true },
            { type: "dislike", count: 0 },
          ],
        },
        { id: 2, text: "gone", createdDate: "2026-07-02T00:00:00Z", isDeleted: true },
      ],
    });
  }
  if (resource === "updates") {
    return encode({
      value: [
        {
          id: 1,
          revisedDate: "2026-07-01T00:00:00Z",
          fields: { "System.Title": { newValue: "x" } },
        },
        {
          id: 2,
          revisedDate: "9999-01-01T00:00:00Z",
          revisedBy: { uniqueName: "theo@acme.test" },
          fields: {
            "System.ChangedDate": { newValue: "2026-07-03T00:00:00Z" },
            "System.State": { oldValue: "Active", newValue: "Resolved" },
            "System.Tags": { oldValue: "ui", newValue: "bug; ui" },
          },
        },
      ],
    });
  }
  throw new Error(`unexpected az invocation ${args.join(" ")}`);
}

function tracker(onExecute: (args: ReadonlyArray<string>) => string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* AzureDevOpsIssueTracker.make.pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
          execute: ({ args }) =>
            Effect.gen(function* () {
              if (args.includes("--in-file")) {
                const body = JSON.parse(
                  yield* fs.readFileString(args[args.indexOf("--in-file") + 1]!).pipe(Effect.orDie),
                );
                if (args.includes("workitemsbatch")) requestBodies.set(args, body);
                if (args.includes("batch")) patchBodies.set(args, body);
              }
              return TestSourceControlHost.processOutput(nativeResponse(args, onExecute(args)));
            }),
        }),
      ),
    );
  }).pipe(Effect.provide(NodeFileSystem.layer));
}

describe("AzureDevOpsIssueTracker", () => {
  it.effect.each(["unauthenticated", "rate-limited", "missing-tool"] as const)(
    "keeps the native principal failure %s",
    (reason) =>
      Effect.gen(function* () {
        const NativeError =
          reason === "unauthenticated"
            ? AzureDevOpsCli.AzureDevOpsCliAuthenticationError
            : reason === "rate-limited"
              ? AzureDevOpsCli.AzureDevOpsCliRateLimitError
              : AzureDevOpsCli.AzureDevOpsCliUnavailableError;
        const cause = new NativeError({
          operation: "execute",
          command: "az",
          cwd: "/w",
          argumentCount: 0,
          cause: "fake native failure",
        });
        const api = yield* AzureDevOpsIssueTracker.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeFileSystem.layer,
              Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
                getCurrentIdentity: () => Effect.fail(cause),
                execute: () => Effect.die("Profiles must not be read"),
              }),
            ),
          ),
        );
        expect(
          yield* api
            .getViewer({
              cwd: "/w",
              host: "dev.azure.com",
              scope: "alpha/Web",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ operation: "getViewer", reason, cause });
      }),
  );
  it.effect.each([
    ["dev.azure.com", "alpha/Web App", "https://dev.azure.com/alpha"],
    ["dev.azure.com", "beta/Web App", "https://dev.azure.com/beta"],
    ["legacy.visualstudio.com", "legacy/Web App", "https://legacy.visualstudio.com"],
    ["legacy.visualstudio.com:443", "legacy/Web App", "https://legacy.visualstudio.com"],
    ["dev.azure.com:443", "alpha/Web App", "https://dev.azure.com/alpha"],
  ] as const)(
    "reads the current account for %s %s without Profiles",
    ([host, scope, organization]) =>
      Effect.gen(function* () {
        const reads: Array<{ cwd: string; organization: string }> = [];
        const api = yield* AzureDevOpsIssueTracker.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeFileSystem.layer,
              Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
                getCurrentIdentity: (input) =>
                  Effect.sync(() => {
                    reads.push(input);
                    return input.organization.includes("/beta")
                      ? "beta@fake.test"
                      : "alpha@fake.test";
                  }),
                execute: () => Effect.die("Profiles must not be read"),
              }),
            ),
          ),
        );
        expect(yield* api.getViewer({ cwd: "/checkout-alpha", host, scope })).toBe(
          organization.includes("/beta") ? "beta@fake.test" : "alpha@fake.test",
        );
        expect(reads).toEqual([{ cwd: "/checkout-alpha", organization }]);
      }),
  );

  it.effect.each([
    { host: "dev.azure.com" },
    { host: "legacy.visualstudio.com:8443", scope: "legacy/Web" },
    { host: "dev.azure.com:8443", scope: "alpha/Web" },
    { host: "dev.azure.com", scope: "alpha" },
    { host: "legacy.visualstudio.com", scope: "other/Web" },
    { host: "legacy.visualstudio.com/extra", scope: "legacy/Web" },
    { host: "user@dev.azure.com", scope: "alpha/Web" },
    { host: "dev.azure.com?elsewhere", scope: "alpha/Web" },
  ])("refuses an incomplete or unsafe viewer scope", (input) =>
    Effect.gen(function* () {
      const api = yield* AzureDevOpsIssueTracker.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeFileSystem.layer,
            Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
              getCurrentIdentity: () => Effect.die("Unsafe identity lookup"),
              execute: () => Effect.die("Profiles must not be read"),
            }),
          ),
        ),
      );
      expect((yield* api.getViewer({ cwd: "/w", ...input }).pipe(Effect.flip)).reason).toBe(
        "failed",
      );
    }),
  );
  it.effect.each([200, 400, 401, 403, 404, 409, 429, 500])(
    "checks the inner native update status %s without retrying",
    (code) =>
      Effect.gen(function* () {
        const calls: ReadonlyArray<string>[] = [];
        const operations: unknown[] = [];
        const api = yield* tracker((args) => {
          calls.push(args);
          if (args.includes("batch")) {
            const body = patchBodies.get(args)!;
            expect(body).toHaveLength(1);
            expect(body[0]).toMatchObject({
              method: "PATCH",
              uri: "/Web%20App/_apis/wit/workitems/7?api-version=7.1",
              headers: { "Content-Type": "application/json-patch+json" },
            });
            operations.push(body[0]!.body);
            return encode({ count: 1, value: [{ code }] });
          }
          return encode({
            ...WORK_ITEM,
            rev: 6,
            multilineFieldsFormat: { "System.Description": "Markdown" },
          });
        });
        const result = yield* api.update!({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
          body: "",
        }).pipe(Effect.result);
        expect(Result.isSuccess(result)).toBe(code === 200);
        if (Result.isFailure(result))
          expect(result.failure.reason).toBe(
            code === 401
              ? "unauthenticated"
              : code === 404
                ? "not-found"
                : code === 429
                  ? "rate-limited"
                  : "failed",
          );
        expect(calls).toHaveLength(2);
        expect(operations).toEqual([
          [
            { op: "test", path: "/rev", value: 6 },
            { op: "add", path: "/fields/System.Description", value: "" },
          ],
        ]);
      }),
  );

  it.effect.each([
    {},
    { count: 0, value: [] },
    { count: 1, value: [{ code: "200" }] },
    { count: 2, value: [{ code: 200 }, { code: 200 }] },
  ])("refuses an unreadable native batch update response", (response) =>
    Effect.gen(function* () {
      let writes = 0;
      const api = yield* tracker((args) => {
        if (args.includes("batch")) {
          writes++;
          return encode(response);
        }
        return encode({ ...WORK_ITEM, rev: 6 });
      });
      const error = yield* api.update!({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
        richBody: { format: "azure-html", document: "" },
      }).pipe(Effect.flip);
      expect(error.reason).toBe("failed");
      expect(writes).toBe(1);
    }),
  );

  it.each([0, 1, "html", "markdown", null, "other"] as const)(
    "decodes native multiline format %s without using body syntax",
    (format) => {
      const result = decodeWorkItemJson(
        encode({
          ...WORK_ITEM,
          multilineFieldsFormat: { "System.Description": format },
        }),
      );
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isFailure(result)) return;
      expect(result.success?.bodyFormat).toBe(
        format === 0 || format === "markdown"
          ? "markdown"
          : format === 1 || format === "html"
            ? "html"
            : null,
      );
    },
  );

  it.each([65_536, 65_537])("bounds native HTML editing at %s characters", (length) => {
    const body = "x".repeat(length);
    const result = decodeWorkItemJson(
      encode({
        ...WORK_ITEM,
        fields: { ...WORK_ITEM.fields, "System.Description": body },
      }),
    );
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) return;
    expect(result.success?.body).toBe(body);
    expect(result.success?.bodyEditable).toBe(length <= 65_536);
    expect(result.success?.richBody).toEqual(
      length <= 65_536 ? { format: "azure-html", document: body } : undefined,
    );
  });
  it.effect.each(["HTML", "Markdown", undefined, "Other"] as const)(
    "keeps the authoritative description format %s",
    (format) =>
      Effect.gen(function* () {
        const body =
          '<table>\r\n<tr><td>A &amp; B</td></tr></table><img src="https://fake.test/a.png">';
        const seen: ReadonlyArray<string>[] = [];
        const api = yield* tracker((args) => {
          seen.push(args);
          if (args[0] === "boards" || readBatch(args) !== null)
            return encode({
              ...WORK_ITEM,
              rev: 2,
              relations: [],
              fields: { ...WORK_ITEM.fields, "System.Description": body },
              ...(format === undefined
                ? {}
                : { multilineFieldsFormat: { "System.Description": format } }),
            });
          return answer(args);
        });
        const detail = yield* api.getIssue({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
        });
        expect(detail.body).toBe(body);
        expect(detail.richBody).toEqual(
          format === "HTML" || format === undefined
            ? { format: "azure-html", document: body }
            : undefined,
        );
        expect(detail.bodyEditable).toBe(format !== "Other");
        expect(seen[0]).toEqual(
          expect.arrayContaining(["devops", "invoke", "workitemsbatch", "project=Web App", "POST"]),
        );
        expect(seen).toHaveLength(3);
      }),
  );

  it.effect.each(["HTML", "Markdown"] as const)(
    "preserves existing %s descriptions on ordinary edits",
    (format) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const before =
          format === "HTML"
            ? '<table>\r\n<tr><td>old</td></tr></table><img src="https://fake.test/a.png">'
            : "**old**";
        const after = before.replace("old", "new");
        const calls: ReadonlyArray<string>[] = [];
        const patches: unknown[] = [];
        const api = yield* AzureDevOpsIssueTracker.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeFileSystem.layer,
              Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
                execute: ({ args }) =>
                  Effect.gen(function* () {
                    calls.push(args);
                    if (args.includes("PATCH"))
                      patches.push(
                        JSON.parse(
                          yield* fs
                            .readFileString(args[args.indexOf("--in-file") + 1]!)
                            .pipe(Effect.orDie),
                        )[0].body,
                      );
                    return TestSourceControlHost.processOutput(
                      nativeResponse(
                        args,
                        encode({
                          ...WORK_ITEM,
                          rev: 6,
                          fields: { ...WORK_ITEM.fields, "System.Description": before },
                          multilineFieldsFormat: { "System.Description": format },
                        }),
                      ),
                    );
                  }),
              }),
            ),
          ),
        );
        yield* api.update!({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
          ...(format === "HTML"
            ? { richBody: { format: "azure-html" as const, document: after } }
            : { body: after }),
        });
        expect(patches).toEqual([
          [
            { op: "test", path: "/rev", value: 6 },
            { op: "add", path: "/fields/System.Description", value: after },
          ],
        ]);
        expect(calls).toHaveLength(2);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect.each([
    ["HTML", { body: "plain" }],
    ["Markdown", { richBody: { format: "azure-html", document: "<p>changed</p>" } }],
    ["HTML", { richBody: { format: "jira-wiki", document: "changed" } }],
    ["HTML", { body: "different", richBody: { format: "azure-html", document: "<p>changed</p>" } }],
    ["Other", { richBody: { format: "azure-html", document: "<p>changed</p>" } }],
    ["HTML", { richBody: { format: "azure-html", document: "x".repeat(65_537) } }],
  ] as const)("refuses a description format change from %s", ([format, change]) =>
    Effect.gen(function* () {
      const calls: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        calls.push(args);
        return encode({
          ...WORK_ITEM,
          rev: 6,
          multilineFieldsFormat: { "System.Description": format },
        });
      });
      const error = yield* api.update!({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
        ...change,
      }).pipe(Effect.flip);
      expect(error.reason).toBe("failed");
      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toContain("PATCH");
    }),
  );

  it.effect.each([undefined, "HTML", "Markdown", "Other"] as const)(
    "does not write a body format for field-only updates on %s",
    (format) =>
      Effect.gen(function* () {
        const calls: ReadonlyArray<string>[] = [];
        const api = yield* tracker((args) => {
          calls.push(args);
          return encode({
            ...WORK_ITEM,
            ...(format === undefined
              ? {}
              : { multilineFieldsFormat: { "System.Description": format } }),
          });
        });
        const input = { cwd: "/w", host: "dev.azure.com", scope: "acme/Web App", key: "7" };
        yield* api.update!({ ...input, title: "Title", labels: [], assignees: [] });
        yield* api.setState!({ ...input, state: "Active" });
        expect(calls).toHaveLength(4);
        expect(calls.filter((args) => args.includes("update"))).toHaveLength(2);
        expect(calls.flat().join(" ")).not.toContain("multilineFieldsFormat");
        expect(calls.flat()).not.toContain("PATCH");
      }),
  );

  it.each(["html", "HTML", 1, "markdown", "Markdown", 0, undefined, "other"] as const)(
    "retains native comment format %s and ownership",
    (format) => {
      const body = "<table>\\r\\n<tr><td>text &amp; bytes</td></tr></table>";
      const result = decodeCommentsJson(
        encode({
          comments: [
            {
              id: 9,
              text: body,
              format,
              createdDate: "2026-07-02T00:00:00Z",
              createdBy: { uniqueName: "actor@fake.test" },
            },
          ],
        }),
        "ACTOR@fake.test",
      );
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isFailure(result)) return;
      const comment = result.success.comments[0]!;
      expect(comment.body).toBe(body);
      expect(comment.richBody).toEqual(
        format === 1 || (typeof format === "string" && format.toLowerCase() === "html")
          ? { format: "azure-html", document: body }
          : undefined,
      );
      expect(comment.canEdit).toBe(format !== undefined && format !== "other");
      const other = decodeCommentsJson(
        encode({
          comments: [
            {
              id: 9,
              text: body,
              format,
              createdDate: "2026-07-02T00:00:00Z",
              createdBy: { uniqueName: "actor@fake.test" },
            },
          ],
        }),
        "other@fake.test",
      );
      expect(Result.isSuccess(other) && other.success.comments[0]?.canEdit).toBe(false);
    },
  );

  it.effect.each(["html", "markdown", 1, 0] as const)(
    "keeps %s comment format through the native CLI",
    (format) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const html = format === "html" || format === 1;
        const text = html ? "<table>\r\n<tr><td>new</td></tr></table>" : "**new**";
        const oldBody = html ? "<p>old native body</p>" : "**old**";
        const comment = Result.getOrThrow(
          decodeCommentsJson(
            encode({
              comments: [
                {
                  id: 9,
                  format,
                  text: oldBody,
                  createdDate: "2026-07-02T00:00:00Z",
                  createdBy: { uniqueName: "actor@fake.test" },
                },
              ],
            }),
            "actor@fake.test",
          ),
        ).comments[0]!;
        expect(comment.canEdit).toBe(true);
        const http: Array<{ method: string; url: string; body: unknown }> = [];
        const api = yield* AzureDevOpsIssueTracker.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeFileSystem.layer,
              Layer.effect(AzureDevOpsCli.AzureDevOpsCli, AzureDevOpsCli.make).pipe(
                Layer.provide(
                  TestSourceControlHost.layer({
                    process: {
                      run: ({ command, args }) =>
                        Effect.gen(function* () {
                          expect(command).toBe("az");
                          if (args[0] === "boards") {
                            http.push({
                              method: "GET",
                              url: "https://dev.azure.com/acme/Web%20App/_apis/wit/workitems/7",
                              body: null,
                            });
                            return TestSourceControlHost.processOutput(encode(WORK_ITEM));
                          }
                          expect(args).toEqual(
                            expect.arrayContaining([
                              "--detect",
                              "false",
                              "--organization",
                              "https://dev.azure.com/acme",
                              "--area",
                              "wit",
                            ]),
                          );
                          const method = args.includes("PATCH") ? "PATCH" : "GET";
                          const resource = args[args.indexOf("--resource") + 1]!;
                          const url =
                            "https://dev.azure.com/acme/Web%20App/_apis/wit/workitems/7" +
                            (resource === "comments" ? "/comments/9" : "");
                          const body = args.includes("--in-file")
                            ? JSON.parse(
                                yield* fs
                                  .readFileString(args[args.indexOf("--in-file") + 1]!)
                                  .pipe(Effect.orDie),
                              )
                            : null;
                          http.push({ method, url, body });
                          if (resource === "workitemsbatch")
                            return TestSourceControlHost.processOutput(encode(WORK_ITEM));
                          expect(args).toEqual(
                            expect.arrayContaining(["commentId=9", "api-version=7.1-preview.4"]),
                          );
                          if (method === "PATCH")
                            expect(args).toContain("format=" + (html ? "html" : "markdown"));
                          return TestSourceControlHost.processOutput(
                            encode({
                              id: 9,
                              format,
                              text: oldBody,
                              createdDate: "2026-07-02T00:00:00Z",
                            }),
                          );
                        }),
                    },
                  }),
                ),
              ),
            ),
          ),
        );
        yield* api.editComment!({
          cwd: "/lending-checkout",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
          commentId: "9",
          body: html ? comment.body : text,
          ...(html ? { richBody: { format: "azure-html" as const, document: text } } : {}),
        });
        expect(http.map((call) => call.method)).toEqual(["GET", "GET", "PATCH"]);
        expect(http[2]?.body).toEqual({ text });
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect.each([
    { format: "html", body: "plain" },
    {
      format: "markdown",
      body: "",
      richBody: { format: "azure-html", document: "<p>changed</p>" },
    },
    { format: "other", body: "changed" },
    { format: undefined, body: "changed" },
    { format: "html", body: "", richBody: { format: "azure-html", document: "" } },
    { format: "html", body: "", richBody: { format: "azure-html", document: "x".repeat(65_537) } },
  ] as const)("refuses unsafe native comment edit $format", (change) =>
    Effect.gen(function* () {
      const calls: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        calls.push(args);
        return args[0] === "boards"
          ? encode(WORK_ITEM)
          : encode({ id: 9, format: change.format, createdDate: "2026-07-02T00:00:00Z" });
      });
      const error = yield* api.editComment!({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
        commentId: "9",
        ...change,
      }).pipe(Effect.flip);
      expect(error.reason).toBe("failed");
      expect(calls).toHaveLength(2);
      expect(calls.flat()).not.toContain("PATCH");
    }),
  );

  it.effect.each(["states", "create-template", "list-templates", "edit-comment"] as const)(
    "uses a CLI-accepted preview version for %s",
    (operation) =>
      Effect.gen(function* () {
        const revisions: string[] = [];
        const api = yield* tracker((args) => {
          const versionIndex = args.indexOf("--api-version");
          if (versionIndex >= 0) {
            const version = args[versionIndex + 1]!;
            expect(Number.isFinite(Number(version.replace("-preview", "")))).toBe(true);
            const resource = args[args.indexOf("--resource") + 1];
            if (
              resource === "templates" ||
              resource === "workitemtypestates" ||
              resource === "comments"
            ) {
              expect(version).toBe("7.1-preview");
              const revision = args.find((arg) => arg.startsWith("api-version="));
              expect(revision).toBe(
                resource === "comments" ? "api-version=7.1-preview.4" : "api-version=7.1-preview.1",
              );
              expect(args).toContain("--query-parameters");
              revisions.push(revision!);
            }
          }
          if (
            args[0] === "boards" ||
            (readBatch(args)?.ids.length === 1 && readBatch(args)?.ids[0] === 7)
          )
            return encode({
              ...WORK_ITEM,
              relations: [],
              fields: {
                ...WORK_ITEM.fields,
                "System.WorkItemType": "Bug",
                "System.State": "Review",
              },
            });
          if (args[1] === "project")
            return encode({ id: "project", name: "Web App", defaultTeam: { id: "team" } });
          const resource = args[args.indexOf("--resource") + 1];
          if (resource === "workitemtypestates")
            return encode({ value: [{ name: "Review", category: "InProgress" }] });
          if (resource === "workitemtypes") return encode({ value: [{ name: "Bug" }] });
          if (resource === "workitemsbatch" || resource === "workitems") return encode(WORK_ITEM);
          if (resource === "templates")
            return encode(
              args.some((arg) => arg.startsWith("templateId="))
                ? { id: "template", name: "Bug", workItemTypeName: "Bug", fields: {} }
                : { value: [{ id: "template" }] },
            );
          if (resource === "comments")
            return encode(
              args.includes("commentId=1")
                ? { id: 1, text: "Before", format: "markdown", createdDate: "2026-07-02T00:00:00Z" }
                : { comments: [] },
            );
          if (resource === "updates")
            return encode({
              value: [1, 2].map((id) => ({ id, revisedDate: "2026-07-03T00:00:00Z" })),
            });
          throw new Error(`Unexpected native resource ${resource}`);
        });
        const target = { cwd: "/w", host: "dev.azure.com", scope: "acme/Web App", key: "7" };
        if (operation === "states")
          expect((yield* api.getIssue(target)).states?.[0]?.name).toBe("Review");
        else if (operation === "create-template")
          expect(
            (yield* api.create!({
              ...target,
              title: "New",
              body: "",
              labels: [],
              assignees: [],
              templateKey: "template",
            })).key,
          ).toBe("7");
        else if (operation === "list-templates")
          expect((yield* api.listTemplates!(target)).templates[0]?.key).toBe("template");
        else yield* api.editComment!({ ...target, commentId: "1", body: "Changed" });
        expect(revisions).toHaveLength(
          operation === "list-templates" || operation === "states" || operation === "edit-comment"
            ? 2
            : 1,
        );
      }),
  );

  it.effect.each([
    {
      before: "Active",
      after: "Resolved",
      beforeCategory: "InProgress",
      afterCategory: "Resolved",
      kind: "state-changed",
    },
    {
      before: "Resolved",
      after: "Closed",
      beforeCategory: "Resolved",
      afterCategory: "Completed",
      kind: "closed",
    },
    {
      before: "Review",
      after: "Shipped",
      beforeCategory: "InProgress",
      afterCategory: "Completed",
      kind: "closed",
    },
    {
      before: "Closed",
      after: "Review",
      beforeCategory: "Completed",
      afterCategory: "InProgress",
      kind: "reopened",
    },
  ])("uses existing native detail workflow for history $before -> $after", (transition) =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((args) => {
        const resource = args[args.indexOf("--resource") + 1];
        paths.push(resource ?? args[0]!);
        if (
          args[0] === "boards" ||
          (readBatch(args)?.ids.length === 1 && readBatch(args)?.ids[0] === 7)
        )
          return encode({
            ...WORK_ITEM,
            relations: [],
            fields: {
              ...WORK_ITEM.fields,
              "System.WorkItemType": "Bug",
              "System.State": transition.after,
            },
          });
        if (resource === "workitemtypestates")
          return encode({
            value: [
              { name: transition.before, category: transition.beforeCategory },
              { name: transition.after, category: transition.afterCategory },
            ],
          });
        if (resource === "updates")
          return encode({
            value: [
              { id: 1, revisedDate: "2026-07-01T00:00:00Z" },
              {
                id: 2,
                revisedDate: "2026-07-03T00:00:00Z",
                fields: {
                  "System.State": { oldValue: transition.before, newValue: transition.after },
                },
              },
            ],
          });
        return answer(args);
      });
      const target = { cwd: "/w", host: "dev.azure.com", scope: "acme/Web App", key: "7" };
      const detail = yield* api.getIssue(target);
      expect(detail.events).toMatchObject([{ kind: transition.kind, detail: transition.after }]);
      expect(paths).toHaveLength(4);
      expect(paths.filter((path) => path === "workitemtypestates")).toHaveLength(1);
      paths.length = 0;
      const history = yield* api.getHistory!(target);
      expect(history.items).toMatchObject([{ kind: "state-changed", detail: transition.after }]);
      expect(paths).toHaveLength(2);
      expect(paths).not.toContain("workitemtypestates");
    }),
  );

  it.effect.each([true, false])(
    "reads candidates in four calls and labels in one with inline states %s",
    (inline) =>
      Effect.gen(function* () {
        let calls = 0;
        const api = yield* tracker((args) => {
          calls += 1;
          if (args[1] === "project")
            return encode({ id: "project", name: "Web App", defaultTeam: { id: "team" } });
          if (args[1] === "team") return encode([]);
          const resource = args[args.indexOf("--resource") + 1];
          if (resource === "tags") return encode({ value: [{ name: "bug" }] });
          if (resource === "workitemtypes")
            return encode({
              value: Array.from({ length: 100 }, (_, index) => ({
                name: `Type ${index}`,
                ...(inline
                  ? { states: [{ name: `Review ${index}`, category: "InProgress" }] }
                  : {}),
              })),
            });
          throw new Error(`Unexpected ${resource}`);
        });
        const scope = { cwd: "/w", host: "dev.azure.com", scope: "acme/Web App" };
        const candidates = yield* api.listCandidates!(scope);
        expect(candidates.states).toHaveLength(inline ? 100 : 0);
        if (inline)
          expect(candidates.states?.[99]).toMatchObject({
            name: "Review 99",
            workflowCategory: "started",
          });
        expect(candidates.truncated).toBe(!inline);
        expect(calls).toBe(4);
        calls = 0;
        expect((yield* api.listLabelCandidates!(scope)).items).toMatchObject([{ name: "bug" }]);
        expect(calls).toBe(1);
      }),
  );

  it.effect(
    "keeps custom states scoped to the current detail with one workflow call and no viewer read",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        let workflowReads = 0;
        const api = yield* tracker((args) => {
          calls += 1;
          if (
            args[0] === "boards" ||
            (readBatch(args)?.ids.length === 1 && readBatch(args)?.ids[0] === 7)
          )
            return encode({
              ...WORK_ITEM,
              relations: [],
              fields: {
                ...WORK_ITEM.fields,
                "System.WorkItemType": "Bug",
                "System.State": "Review",
              },
            });
          const resource = args[args.indexOf("--resource") + 1];
          if (resource === "workitemtypestates") {
            workflowReads += 1;
            expect(args).toContain("type=Bug");
            return encode({
              value: [
                { name: "Review", category: "InProgress" },
                { name: "Shipped", category: "Completed" },
              ],
            });
          }
          return answer(args);
        });
        const detail = yield* api.getIssue({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
        });
        expect(detail.state).toMatchObject({
          name: "Review",
          id: "Review",
          workflowCategory: "started",
        });
        expect(detail.states?.map((state) => state.name)).toEqual(["Review", "Shipped"]);
        expect(detail.viewer).toBeNull();
        expect(workflowReads).toBe(1);
        expect(calls).toBe(4);
      }),
  );

  it.effect.each(["Web App", "a0000000-0000-0000-0000-000000000001"])(
    "bounds cross-project hierarchy reads and keeps the next raw relation page for %s",
    (project) =>
      Effect.gen(function* () {
        let calls = 0;
        const api = yield* tracker((args) => {
          calls += 1;
          if (args.slice(0, 3).join(" ") === "devops project show")
            return encode({ id: "a0000000-0000-0000-0000-000000000001", name: "Web App" });
          if (
            args[0] === "boards" ||
            (readBatch(args)?.ids.length === 1 && readBatch(args)?.ids[0] === 7)
          )
            return encode({
              ...WORK_ITEM,
              relations: [
                {
                  rel: "System.LinkTypes.Hierarchy-Reverse",
                  url: "https://dev.azure.com/acme/_apis/wit/workItems/4",
                },
                ...Array.from({ length: 15 }, (_, index) => ({
                  rel: "System.LinkTypes.Hierarchy-Forward",
                  url: `https://dev.azure.com/acme/_apis/wit/workItems/${index + 20}`,
                })),
              ],
            });
          const resource = args[args.indexOf("--resource") + 1];
          if (resource === "workitemsbatch")
            return encode({
              value: (readBatch(args)?.ids ?? []).map((key) => ({
                ...WORK_ITEM,
                id: Number(key),
                fields: {
                  ...WORK_ITEM.fields,
                  "System.TeamProject": `Project ${key}`,
                  "System.WorkItemType": "Bug",
                  "System.State": "Review",
                },
              })),
            });
          if (resource === "workitemtypes")
            return encode({
              value: [{ name: "Bug", states: [{ name: "Review", category: "InProgress" }] }],
            });
          throw new Error(`Unexpected ${resource}`);
        });
        const target = {
          cwd: "/w",
          host: "dev.azure.com",
          scope: `acme/${project}`,
          key: "7",
          limit: 100,
        };
        const first = yield* api.getHierarchy!(target);
        expect(first.parent?.key).toBe("4");
        expect(first.children.items.map((item) => item.key)).toEqual(
          Array.from({ length: 10 }, (_, index) => String(index + 20)),
        );
        expect(first.children.nextCursor).toBe("10");
        expect(calls).toBe(project === "Web App" ? 13 : 14);
        calls = 0;
        const second = yield* api.getHierarchy!({ ...target, cursor: first.children.nextCursor! });
        expect(second.children.items.map((item) => item.key)).toEqual([
          "30",
          "31",
          "32",
          "33",
          "34",
        ]);
        expect(second.children.nextCursor).toBeNull();
        expect(calls).toBe(project === "Web App" ? 8 : 9);
      }),
  );

  it.effect("lists a project GUID through its native project name", () =>
    Effect.gen(function* () {
      const api = yield* tracker((args) => {
        if (args[1] === "project")
          return encode({
            id: "a0000000-0000-0000-0000-000000000001",
            name: "Web App",
            defaultTeam: { id: "team" },
          });
        const resource = args[args.indexOf("--resource") + 1];
        expect(args).toContain("project=Web App");
        return resource === "wiql"
          ? encode({ workItems: [{ id: 7 }] })
          : encode({ value: [WORK_ITEM] });
      });
      expect(
        yield* api.listIssues({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/a0000000-0000-0000-0000-000000000001",
          state: "all",
          involvement: "all",
          viewer: "julius",
          limit: 1,
        }),
      ).toMatchObject({ items: [{ key: "7" }] });
    }),
  );

  it.effect.each(["all", "open"] as const)(
    "uses one inline workflow read for a list page across 100 native types in state %s",
    (state) =>
      Effect.gen(function* () {
        let workflowReads = 0;
        let calls = 0;
        const api = yield* tracker((args) => {
          calls += 1;
          const resource = args[args.indexOf("--resource") + 1];
          if (resource === "wiql")
            return encode({ workItems: Array.from({ length: 101 }, (_, id) => ({ id: id + 7 })) });
          if (resource === "workitemsbatch")
            return encode({
              value: Array.from({ length: 100 }, (_, index) => ({
                ...WORK_ITEM,
                id: index + 7,
                fields: {
                  ...WORK_ITEM.fields,
                  "System.WorkItemType": `Type ${index}`,
                  "System.TeamProject": index % 2 === 0 ? "Web App" : "WEB APP",
                  "System.State": "Review",
                },
              })),
            });
          if (resource === "workitemtypes") {
            workflowReads += 1;
            return encode({
              value: Array.from({ length: 100 }, (_, index) => ({
                name: `Type ${index}`,
                states: [
                  { name: "Review", category: "InProgress" },
                  { name: "Shipped", category: "Completed" },
                ],
              })),
            });
          }
          throw new Error(`Unexpected ${resource}`);
        });
        const page = yield* api.listIssues({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          state,
          involvement: "all",
          viewer: "julius@acme.test",
          sort: "comments",
          order: "asc",
          limit: 100,
        });
        expect(page.items.map((item) => item.state)).toEqual(
          Array.from({ length: 100 }, () => ({
            category: "open",
            name: "Review",
            id: "Review",
            workflowCategory: "started",
          })),
        );
        expect(JSON.parse(page.nextCursor!)).toEqual({
          sort: "comments",
          order: "asc",
          value: 2,
          id: 106,
        });
        expect(workflowReads).toBe(1);
        expect(calls).toBe(3);
      }),
  );

  it.effect("creates with native template fields and changes a parent under a revision check", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const patches: unknown[] = [];
      const item = {
        ...WORK_ITEM,
        rev: 6,
        fields: { ...WORK_ITEM.fields, "System.WorkItemType": "Bug" },
        relations: [
          {
            rel: "System.LinkTypes.Hierarchy-Reverse",
            url: "https://dev.azure.com/acme/_apis/wit/workItems/4",
          },
        ],
      };
      const api = yield* AzureDevOpsIssueTracker.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeFileSystem.layer,
            Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
              execute: ({ args }) =>
                Effect.gen(function* () {
                  const resource = args[args.indexOf("--resource") + 1];
                  const inFile = args.indexOf("--in-file");
                  if (inFile >= 0) {
                    expect(args[args.indexOf("--media-type") + 1]).toBe(
                      resource === "batch" ? "application/json" : "application/json-patch+json",
                    );
                    const payload = JSON.parse(
                      yield* fs.readFileString(args[inFile + 1]!).pipe(Effect.orDie),
                    );
                    patches.push(resource === "batch" ? payload[0].body : payload);
                    return TestSourceControlHost.processOutput(
                      nativeResponse(args, encode({ ...item, id: 55 })),
                    );
                  }
                  if (
                    args[0] === "boards" ||
                    (readBatch(args)?.ids.length === 1 && readBatch(args)?.ids[0] === 7)
                  ) {
                    const id = Number(
                      args.find((arg) => arg.startsWith("id="))?.slice(3) ??
                        args[args.indexOf("--id") + 1],
                    );
                    return TestSourceControlHost.processOutput(
                      nativeResponse(
                        args,
                        encode({
                          ...item,
                          id,
                          url: `https://dev.azure.com/acme/_apis/wit/workItems/${id}`,
                        }),
                      ),
                    );
                  }
                  if (args[0] === "devops" && args[1] === "project")
                    return TestSourceControlHost.processOutput(
                      nativeResponse(
                        args,
                        encode({
                          id: "project-id",
                          name: "Web App",
                          defaultTeam: { id: "team-id" },
                        }),
                      ),
                    );
                  if (resource === "workitemtypes")
                    return TestSourceControlHost.processOutput(
                      nativeResponse(args, encode({ value: [{ name: "Bug" }] })),
                    );
                  if (resource === "templates")
                    return TestSourceControlHost.processOutput(
                      nativeResponse(
                        args,
                        encode({
                          id: "bug-template",
                          name: "Bug",
                          workItemTypeName: "Bug",
                          fields: {
                            "System.Title": "Default title",
                            "Custom.Priority": "High",
                            "System.Tags": "template-tag",
                            "System.AssignedTo": "template@acme.test",
                          },
                        }),
                      ),
                    );
                  throw new Error(`Unexpected ${args.join(" ")}`);
                }),
            }),
          ),
        ),
      );
      const target = { cwd: "/w", host: "dev.azure.com", scope: "acme/Web App", key: "7" };
      expect(
        yield* api.create!({
          ...target,
          title: "User title",
          body: "Body",
          labels: [],
          assignees: [],
          templateKey: "bug-template",
          parentKey: "8",
        }),
      ).toMatchObject({ key: "55", parentLinked: true });
      expect(patches[0]).toEqual(
        expect.arrayContaining([
          { op: "add", path: "/fields/System.Title", value: "User title" },
          { op: "add", path: "/fields/Custom.Priority", value: "High" },
          { op: "add", path: "/fields/System.Tags", value: "" },
          { op: "add", path: "/fields/System.AssignedTo", value: "" },
          {
            op: "add",
            path: "/relations/-",
            value: {
              rel: "System.LinkTypes.Hierarchy-Reverse",
              url: "https://dev.azure.com/acme/_apis/wit/workItems/8",
            },
          },
        ]),
      );
      yield* api.setParent!({ ...target, parentKey: "8" });
      yield* api.setParent!({ ...target, parentKey: null });
      expect(patches[1]).toEqual([
        { op: "test", path: "/rev", value: 6 },
        { op: "remove", path: "/relations/0" },
        {
          op: "add",
          path: "/relations/-",
          value: {
            rel: "System.LinkTypes.Hierarchy-Reverse",
            url: "https://dev.azure.com/acme/_apis/wit/workItems/8",
          },
        },
      ]);
      expect(patches[2]).toEqual([
        { op: "test", path: "/rev", value: 6 },
        { op: "remove", path: "/relations/0" },
      ]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect.each([
    {
      input: { body: "**bold**\n\n- one\n- two" },
      fields: [
        { op: "add", path: "/fields/System.Description", value: "**bold**\n\n- one\n- two" },
      ],
    },
    {
      input: {
        title: "Changed title",
        body: "**bold**",
        labels: ["bug", "updated"],
        assignees: ["theo@acme.test"],
      },
      fields: [
        { op: "add", path: "/fields/System.Title", value: "Changed title" },
        { op: "add", path: "/fields/System.Description", value: "**bold**" },
        { op: "add", path: "/fields/System.Tags", value: "bug; updated" },
        { op: "add", path: "/fields/System.AssignedTo", value: "theo@acme.test" },
      ],
    },
    {
      input: { body: "", labels: [], assignees: [] },
      fields: [
        { op: "add", path: "/fields/System.Description", value: "" },
        { op: "add", path: "/fields/System.Tags", value: "" },
        { op: "add", path: "/fields/System.AssignedTo", value: "" },
      ],
    },
  ] as const)(
    "keeps an existing Markdown description in its native format: $input",
    ({ input, fields }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const seen: ReadonlyArray<string>[] = [];
        const patches: unknown[] = [];
        const api = yield* AzureDevOpsIssueTracker.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeFileSystem.layer,
              Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
                execute: ({ args }) =>
                  Effect.gen(function* () {
                    seen.push(args);
                    if (args.includes("PATCH")) {
                      expect(args).toEqual(
                        expect.arrayContaining([
                          "devops",
                          "invoke",
                          "--organization",
                          "https://dev.azure.com/acme",
                          "--resource",
                          "batch",
                          "--api-version",
                          "7.1",
                          "project=Web App",
                          "PATCH",
                          "application/json",
                        ]),
                      );
                      patches.push(
                        JSON.parse(
                          yield* fs
                            .readFileString(args[args.indexOf("--in-file") + 1]!)
                            .pipe(Effect.orDie),
                        )[0].body,
                      );
                    }
                    return TestSourceControlHost.processOutput(
                      nativeResponse(
                        args,
                        encode({
                          ...WORK_ITEM,
                          rev: 6,
                          multilineFieldsFormat: { "System.Description": "Markdown" },
                        }),
                      ),
                    );
                  }),
              }),
            ),
          ),
        );
        yield* api.update!({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
          ...input,
        });
        expect(patches).toEqual([[{ op: "test", path: "/rev", value: 6 }, ...fields]]);
        expect(seen).toHaveLength(2);
        expect(seen[0]).toEqual(
          expect.arrayContaining(["devops", "invoke", "workitemsbatch", "POST"]),
        );
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("keeps updates without a body on the native CLI field path", () =>
    Effect.gen(function* () {
      const seen: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        seen.push(args);
        return encode(WORK_ITEM);
      });
      yield* api.update!({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
        title: "Changed title",
        labels: [],
        assignees: [],
      });
      expect(seen).toHaveLength(2);
      expect(seen[1]).toEqual([
        "boards",
        "work-item",
        "update",
        "--detect",
        "false",
        "--organization",
        "https://dev.azure.com/acme",
        "--id",
        "7",
        "--title",
        "Changed title",
        "--fields",
        "System.Tags=",
        "System.AssignedTo=",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );

  it.effect.each([
    [400, "command-failed", "failed"],
    [401, "authentication", "unauthenticated"],
    [403, "command-failed", "failed"],
    [409, "command-failed", "failed"],
    [429, "rate-limited", "rate-limited"],
  ] as const)(
    "keeps native body update error %s without a fallback write",
    ([status, failureKind, reason]) =>
      Effect.gen(function* () {
        const seen: ReadonlyArray<string>[] = [];
        const cause = new VcsProcessExitError({
          operation: "AzureDevOpsCli.execute",
          command: "az",
          cwd: "/w",
          exitCode: 1,
          detail: `HTTP ${status}`,
          failureKind,
        });
        const api = yield* AzureDevOpsIssueTracker.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeFileSystem.layer,
              Layer.effect(AzureDevOpsCli.AzureDevOpsCli, AzureDevOpsCli.make).pipe(
                Layer.provide(
                  TestSourceControlHost.layer({
                    process: {
                      run: ({ args }) => {
                        seen.push(args);
                        return !args.includes("PATCH")
                          ? Effect.succeed(
                              TestSourceControlHost.processOutput(
                                nativeResponse(
                                  args,
                                  encode({
                                    ...WORK_ITEM,
                                    rev: 6,
                                    multilineFieldsFormat: { "System.Description": "Markdown" },
                                  }),
                                ),
                              ),
                            )
                          : Effect.fail(cause);
                      },
                    },
                  }),
                ),
              ),
            ),
          ),
        );
        const error = yield* Effect.flip(
          api.update!({
            cwd: "/w",
            host: "dev.azure.com",
            scope: "acme/Web App",
            key: "7",
            body: "**bold**",
          }),
        );
        expect(error).toMatchObject({ operation: "update", reason, cause: { cause } });
        expect(seen).toHaveLength(2);
        expect(seen[1]).toContain("PATCH");
      }),
  );

  it.effect.each([
    ["acme.visualstudio.com", "https://acme.visualstudio.com"],
    ["acme.visualstudio.com", "https://acme.visualstudio.com/DefaultCollection"],
    ["dev.azure.com", "https://dev.azure.com/acme"],
    ["azure.test/mount", "https://azure.test/mount/acme"],
  ] as const)("reads native hierarchy pages at %s %s", ([host, prefix]) =>
    Effect.gen(function* () {
      const seen: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        seen.push(args);
        if (
          args[0] === "boards" ||
          (readBatch(args)?.ids.length === 1 && readBatch(args)?.ids[0] === 7)
        )
          return encode({
            ...WORK_ITEM,
            url: `${prefix}/_apis/wit/workItems/7`,
            relations: [
              { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${prefix}/_apis/wit/workItems/4` },
              ...[8, 9].map((id) => ({
                rel: "System.LinkTypes.Hierarchy-Forward",
                url: `${prefix}/_apis/wit/workItems/${id}`,
              })),
            ],
          });
        return encode({
          value: (readBatch(args)?.ids ?? []).map((id) => ({
            ...WORK_ITEM,
            id: Number(id),
            url: `${prefix}/_apis/wit/workItems/${id}`,
            fields: { ...WORK_ITEM.fields, "System.TeamProject": "Other App" },
          })),
        });
      });
      const target = { cwd: "/w", host, scope: "acme/Web App", key: "7", limit: 1 };
      const first = yield* api.getHierarchy!(target);
      expect(first).toMatchObject({
        parent: { key: "4", scope: "acme/Other App" },
        children: { items: [{ key: "8", scope: "acme/Other App" }], nextCursor: "1" },
      });
      expect(seen).toHaveLength(2);
      expect(readBatch(seen[1]!)?.ids).toEqual([4, 8]);
      const second = yield* api.getHierarchy!({ ...target, cursor: first.children.nextCursor! });
      expect(second).toMatchObject({
        parent: { key: "4" },
        children: { items: [{ key: "9" }], nextCursor: null },
      });
      expect(seen).toHaveLength(4);
      expect(readBatch(seen[3]!)?.ids).toEqual([4, 9]);
    }),
  );

  it.effect.each([
    [
      "acme.visualstudio.com",
      "https://acme.visualstudio.com",
      "https://foreign.visualstudio.com/_apis/wit/workItems/8",
    ],
    [
      "dev.azure.com",
      "https://dev.azure.com/acme",
      "https://foreign.test/acme/_apis/wit/workItems/8",
    ],
    [
      "dev.azure.com",
      "https://dev.azure.com/acme",
      "https://dev.azure.com/acme-other/_apis/wit/workItems/8",
    ],
    [
      "azure.test/mount",
      "https://azure.test/mount/acme",
      "https://azure.test/other/acme/_apis/wit/workItems/8",
    ],
    [
      "azure.test/mount",
      "https://azure.test/mount/acme",
      "https://azure.test/mount/acme-other/_apis/wit/workItems/8",
    ],
    [
      "dev.azure.com",
      "https://dev.azure.com/acme",
      "https://dev.azure.com/acme/_apis/wit/workItems/8/comments/1",
    ],
  ] as const)("refuses an out-of-scope native hierarchy relation %s %s %s", ([host, prefix, url]) =>
    Effect.gen(function* () {
      let calls = 0;
      const api = yield* tracker(() => {
        calls += 1;
        return encode({
          ...WORK_ITEM,
          url: `${prefix}/_apis/wit/workItems/7`,
          relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url }],
        });
      });
      const error = yield* Effect.flip(
        api.getHierarchy!({ cwd: "/w", host, scope: "acme/Web App", key: "7" }),
      );
      expect(error).toMatchObject({ operation: "getHierarchy", reason: "failed" });
      expect(calls).toBe(1);
    }),
  );

  it.effect("pages child relations into their own projects", () =>
    Effect.gen(function* () {
      const api = yield* tracker((args) => {
        if (
          args[0] === "boards" ||
          (readBatch(args)?.ids.length === 1 && readBatch(args)?.ids[0] === 7)
        )
          return encode({
            ...WORK_ITEM,
            relations: [8, 9].map((id) => ({
              rel: "System.LinkTypes.Hierarchy-Forward",
              url: `https://dev.azure.com/acme/_apis/wit/workItems/${id}`,
            })),
          });
        expect(readBatch(args)?.ids).toEqual([9]);
        return encode({
          value: [
            {
              ...WORK_ITEM,
              id: 9,
              fields: { ...WORK_ITEM.fields, "System.TeamProject": "Other App" },
            },
          ],
        });
      });
      expect(
        yield* api.getHierarchy!({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
          cursor: "1",
          limit: 1,
        }),
      ).toMatchObject({
        parent: null,
        children: { items: [{ scope: "acme/Other App", key: "9" }], nextCursor: null },
      });
    }),
  );

  it.effect.each([
    ["getIssue", "JULIUS@acme.test", true],
    ["getIssue", "other@acme.test", false],
    ["getComments", undefined, undefined],
    ["getComments", "JULIUS@acme.test", true],
    ["getComments", "other@acme.test", false],
  ] as const)("keeps %s comment edit rights for viewer %s", ([operation, viewer, canEdit]) =>
    Effect.gen(function* () {
      const seen: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        seen.push(args);
        return answer(args);
      });
      const input = {
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
        ...(viewer === undefined ? {} : { viewer }),
      };
      const result = yield* operation === "getIssue" ? api.getIssue(input) : api.getComments(input);
      expect(result.comments[0]?.canEdit).toBe(canEdit);
      expect(seen).toHaveLength(operation === "getIssue" ? 4 : 2);
    }),
  );

  it.effect("lets the native token decide comment edit rights when the viewer is unknown", () =>
    Effect.gen(function* () {
      const paths: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        paths.push(args);
        if (
          args[0] === "boards" ||
          (readBatch(args)?.ids.length === 1 && readBatch(args)?.ids[0] === 7)
        )
          return encode(WORK_ITEM);
        return encode({
          id: 1,
          text: "Before",
          format: "markdown",
          createdDate: "2026-07-02T00:00:00Z",
          createdBy: { uniqueName: "someone@acme.test" },
        });
      });
      yield* api.editComment!({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
        commentId: "1",
        body: "Changed",
      });
      expect(paths).toHaveLength(3);
      expect(paths.flat()).not.toContain("profiles");
      expect(paths.flat()).toContain("PATCH");
    }),
  );

  it.effect.each([
    [401, "authentication", "unauthenticated"],
    [403, "command-failed", "failed"],
    [429, "rate-limited", "rate-limited"],
  ] as const)("keeps native comment edit error %s", ([status, failureKind, reason]) =>
    Effect.gen(function* () {
      const seen: ReadonlyArray<string>[] = [];
      const cause = new VcsProcessExitError({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        cwd: "/w",
        exitCode: 1,
        detail: `HTTP ${status}`,
        failureKind,
      });
      const api = yield* AzureDevOpsIssueTracker.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeFileSystem.layer,
            Layer.effect(AzureDevOpsCli.AzureDevOpsCli, AzureDevOpsCli.make).pipe(
              Layer.provide(
                TestSourceControlHost.layer({
                  process: {
                    run: ({ args }) => {
                      seen.push(args);
                      return !args.includes("PATCH")
                        ? Effect.succeed(
                            TestSourceControlHost.processOutput(
                              encode(
                                args.includes("comments")
                                  ? {
                                      id: 1,
                                      format: "markdown",
                                      createdDate: "2026-07-02T00:00:00Z",
                                    }
                                  : {
                                      ...WORK_ITEM,
                                      rev: 6,
                                      multilineFieldsFormat: { "System.Description": "Markdown" },
                                    },
                              ),
                            ),
                          )
                        : Effect.fail(cause);
                    },
                  },
                }),
              ),
            ),
          ),
        ),
      );
      const error = yield* Effect.flip(
        api.editComment!({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
          commentId: "1",
          body: "Changed",
        }),
      );
      expect(error).toMatchObject({ operation: "editComment", reason, cause: { cause } });
      expect(seen).toHaveLength(3);
      expect(seen[2]).toEqual(
        expect.arrayContaining([
          "PATCH",
          "project=Web App",
          "workItemId=7",
          "commentId=1",
          "7.1-preview",
          "api-version=7.1-preview.4",
          "format=markdown",
        ]),
      );
    }),
  );

  it("skips malformed artifact relation escaping", () => {
    expect(
      pullRequestNumberOf({
        rel: "ArtifactLink",
        url: "vstfs:///Git/PullRequestId/project%ZZrepo%2F50",
      }),
    ).toBeNull();
  });

  it.each([
    [
      "https://dev.azure.com/acme/_apis/wit/workItems/7",
      "https://dev.azure.com/acme/Web%20App/_workitems/edit/7",
    ],
    [
      "https://dev.azure.com/acme/Web%20App/_apis/wit/workItems/7",
      "https://dev.azure.com/acme/Web%20App/_workitems/edit/7",
    ],
    [
      "https://acme.visualstudio.com/_apis/wit/workItems/7",
      "https://acme.visualstudio.com/Web%20App/_workitems/edit/7",
    ],
    [
      "https://acme.visualstudio.com/Web%20App/_apis/wit/workItems/7",
      "https://acme.visualstudio.com/Web%20App/_workitems/edit/7",
    ],
    [
      "https://acme.visualstudio.com/DefaultCollection/_apis/wit/workItems/7",
      "https://acme.visualstudio.com/DefaultCollection/Web%20App/_workitems/edit/7",
    ],
    [
      "https://acme.visualstudio.com/DefaultCollection/Web%20App/_apis/wit/workItems/7",
      "https://acme.visualstudio.com/DefaultCollection/Web%20App/_workitems/edit/7",
    ],
    ["not a URL", null],
    ["https://[acme/_apis/wit/workItems/7", null],
  ])("decodes native work-item URLs for detail, create and lists: %s", (url, expected) => {
    const item = { ...WORK_ITEM, url };
    const detail = Result.getOrThrow(decodeWorkItemJson(encode(item)));
    const list = Result.getOrThrow(decodeWorkItemsJson(encode({ value: [item] })));
    expect(detail?.url ?? null).toBe(expected);
    expect(list.map((row) => row.url)).toEqual(expected === null ? [] : [expected]);
  });

  it.effect("declares only native comment reactions", () =>
    Effect.gen(function* () {
      const api = yield* tracker(() => {
        throw new Error("Capabilities must not call Azure");
      });
      expect(api.capabilities).toMatchObject({
        reactions: false,
        commentReactions: true,
        reactionContents: ["thumbs-up", "thumbs-down", "heart", "hooray", "laugh", "confused"],
      });
    }),
  );

  it.effect.each([
    { content: "thumbs-up", native: "like" },
    { content: "thumbs-down", native: "dislike" },
    { content: "heart", native: "heart" },
    { content: "hooray", native: "hooray" },
    { content: "laugh", native: "smile" },
    { content: "confused", native: "confused" },
  ] as const)("adds and removes native comment reaction $native", ({ content, native }) =>
    Effect.gen(function* () {
      const seen: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        seen.push(args);
        return args[0] === "boards" ? encode(WORK_ITEM) : "{}";
      });
      for (const reacted of [true, false]) {
        yield* api.setReaction!({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
          subjectId: "12",
          content,
          reacted,
        });
      }
      expect(seen).toHaveLength(4);
      for (const [index, method] of [
        [1, "PUT"],
        [3, "DELETE"],
      ] as const) {
        expect(seen[index]).toEqual(
          expect.arrayContaining([
            "commentsReactions",
            "workItemId=7",
            "commentId=12",
            `reactionType=${native}`,
            method,
            "api-version=7.1-preview.1",
          ]),
        );
      }
    }),
  );

  it.effect("maps a work item, its conversation and revisions to the neutral issue shape", () =>
    Effect.gen(function* () {
      const seen: string[][] = [];
      const api = yield* tracker((args) => {
        seen.push([...args]);
        return answer(args);
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
      });
      // Every command names the organization rather than detecting it from the checkout.
      for (const args of seen) {
        expect(args).toContain("https://dev.azure.com/acme");
      }
      expect(issue).toMatchObject({
        key: "7",
        displayKey: "#7",
        title: "Composer loses focus",
        url: "https://dev.azure.com/acme/Web%20App/_workitems/edit/7",
        // The project's own state name survives; the category is what the list filters by.
        state: { category: "closed", name: "Resolved" },
        author: { login: "octo@acme.test", name: "Octo Cat" },
        assignees: [{ login: "Theo <theo@acme.test>" }],
        labels: [
          { name: "bug", color: null },
          { name: "ui", color: null },
        ],
        commentCount: 2,
        body: "<p>Typing drops focus.</p>",
        commentsCursor: expect.any(String),
        historyTruncated: false,
        viewerPermissions: { setState: true, edit: true, labels: true, assignees: true },
      });
      expect(issue.comments).toEqual([
        {
          id: "1",
          author: { login: "julius@acme.test", name: "Julius", avatarUrl: null },
          body: "Repro attached.",
          createdAt: "2026-07-02T00:00:00Z",
          editedAt: null,
          canEdit: undefined,
          url: null,
          reactions: [{ content: "thumbs-up", count: 2, actors: [], viewerHasReacted: true }],
        },
      ]);
      expect(issue.events.map((event) => [event.kind, event.detail])).toEqual([
        ["state-changed", "Resolved"],
        ["labeled", "bug"],
      ]);
      expect(issue.events.map((event) => event.createdAt)).toEqual([
        "2026-07-03T00:00:00Z",
        "2026-07-03T00:00:00Z",
      ]);
      expect(issue.linkedPullRequests).toEqual([
        {
          repository: "Web App/web",
          number: 50,
          title: "fix(web): keep composer focus",
          url: "https://dev.azure.com/acme/Web%20App/_git/web/pullrequest/50",
          state: "merged",
          isDraft: false,
          closesIssue: false,
        },
      ]);
    }),
  );

  it.effect(
    "marks a full native update page as partial even when most updates have no events",
    () =>
      Effect.gen(function* () {
        for (const total of [101, 100, 99]) {
          const seen: ReadonlyArray<string>[] = [];
          const updates = Array.from({ length: total }, (_, index) => ({
            id: index + 1,
            rev: 2,
            revisedDate: "9999-01-01T00:00:00Z",
            revisedBy: { uniqueName: "theo@acme.test" },
            fields: {
              "System.ChangedDate": { newValue: "2026-07-03T00:00:00Z" },
              ...(index === total - 1
                ? { "System.State": { oldValue: "Active", newValue: "Resolved" } }
                : index === 1
                  ? {
                      "System.Title": { oldValue: "Old title", newValue: "New title" },
                      "System.Tags": { oldValue: "", newValue: "bug" },
                    }
                  : {}),
            },
          }));
          const api = yield* tracker((args) => {
            seen.push(args);
            const resource = args[args.indexOf("--resource") + 1];
            if (resource === "updates") {
              const top = Number(args.find((arg) => arg.startsWith("$top="))?.slice(5));
              const skip = Number(args.find((arg) => arg.startsWith("$skip="))?.slice(6) ?? 0);
              return encode({
                count: Math.min(top, total - skip),
                value: updates.slice(skip, skip + top),
              });
            }
            if (args[0] === "boards" || readBatch(args) !== null)
              return encode({ ...WORK_ITEM, rev: total });
            return answer(args);
          });
          const issue = yield* api.getIssue({
            cwd: "/w",
            host: "dev.azure.com",
            scope: "acme/Web App",
            key: "7",
          });
          expect(issue.historyTruncated).toBe(total > 100);
          expect(issue.state).toEqual({ category: "closed", name: "Resolved" });
          expect(issue.events.map((event) => event.kind)).toEqual([
            "state-changed",
            "renamed",
            "labeled",
          ]);
          expect(issue.events[0]).toMatchObject({
            id: `update-${total}-0`,
            actor: { login: "theo@acme.test" },
            createdAt: "2026-07-03T00:00:00Z",
            detail: "Resolved",
          });
          expect(seen).toHaveLength(4);
          expect(seen.filter((args) => args.includes("updates"))).toHaveLength(1);
          expect(seen.find((args) => args.includes("updates"))).toContain(
            `$top=${Math.min(100, total)}`,
          );
        }
      }),
  );

  it.effect("lists the native bulk work-item wrapper in one bounded page", () =>
    Effect.gen(function* () {
      const seen: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        seen.push(args);
        const resource = args[args.indexOf("--resource") + 1];
        if (resource === "wiql")
          return encode({ workItems: [{ id: 7 }, { id: 8 }], asOf: "2026-07-04T00:00:00Z" });
        if (resource === "workitemsbatch") return encode({ count: 1, value: [WORK_ITEM] });
        throw new Error(`Unexpected resource ${resource}`);
      });
      const page = yield* api.listIssues({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        state: "all",
        involvement: "all",
        viewer: "julius@acme.test",
        limit: 1,
      });
      expect(page.items.map((item) => item.key)).toEqual(["7"]);
      expect(page.nextCursor).toBe("2026-07-03T00:00:00Z|7");
      expect(seen).toHaveLength(2);
      expect(readBatch(seen[1]!)).toMatchObject({ ids: [7], asOf: "2026-07-04T00:00:00Z" });
    }),
  );

  it.effect("keeps WIQL ordering and its cursor when native bulk rows arrive by ID", () =>
    Effect.gen(function* () {
      const seen: ReadonlyArray<string>[] = [];
      const rows = [1, 2, 3].map((id) => ({
        ...WORK_ITEM,
        id,
        fields: { ...WORK_ITEM.fields, "System.ChangedDate": `2026-07-0${id}T00:00:00Z` },
      }));
      let queries = 0;
      const api = yield* tracker((args) => {
        seen.push(args);
        const resource = args[args.indexOf("--resource") + 1];
        if (resource === "wiql")
          return encode({
            workItems: (++queries === 1 ? [3, 2, 1] : [1]).map((id) => ({ id })),
          });
        if (resource === "workitemsbatch")
          return encode({
            count: queries === 1 ? 2 : 1,
            value: queries === 1 ? [rows[1], rows[2]] : [rows[0]],
          });
        throw new Error(`Unexpected resource ${resource}`);
      });
      const target = {
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        state: "all" as const,
        involvement: "all" as const,
        viewer: "julius@acme.test",
        limit: 2,
      };
      const first = yield* api.listIssues(target);
      expect(first.items.map((item) => item.key)).toEqual(["3", "2"]);
      expect(first.nextCursor).toBe("2026-07-02T00:00:00Z|2");
      const second = yield* api.listIssues({ ...target, cursor: first.nextCursor! });
      expect(second.items.map((item) => item.key)).toEqual(["1"]);
      expect(second.nextCursor).toBeNull();
      expect(seen).toHaveLength(4);
    }),
  );

  it.effect("refuses the unsupported mentioned filter before any Azure request", () =>
    Effect.gen(function* () {
      let requests = 0;
      const api = yield* tracker(() => {
        requests += 1;
        return encode({ workItems: [] });
      });
      const error = yield* Effect.flip(
        api.listIssues({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          state: "all",
          involvement: "mentioned",
          viewer: "julius@acme.test",
          limit: 10,
        }),
      );
      expect(error.detail).toContain("mentioned");
      expect(requests).toBe(0);
      expect(api.capabilities.maxAssignees).toBe(1);
      expect(api.capabilities.involvements).toEqual(["all", "assigned", "authored"]);
    }),
  );

  it.effect.each(["update", "update-body", "setState", "getIssue", "getComments"] as const)(
    "rejects a foreign native project before %s",
    (operation) =>
      Effect.gen(function* () {
        const seen: ReadonlyArray<string>[] = [];
        const api = yield* tracker((args) => {
          seen.push(args);
          return answer(args);
        });
        const target = { cwd: "/w", host: "dev.azure.com", scope: "acme/Other", key: "7" };
        const task =
          operation === "update"
            ? api.update!({ ...target, title: "Changed title" })
            : operation === "update-body"
              ? api.update!({ ...target, body: "**bold**" })
              : operation === "setState"
                ? api.setState!({ ...target, state: "New" })
                : operation === "getComments"
                  ? api.getComments(target)
                  : api.getIssue(target);
        const error = yield* Effect.flip(task);
        expect(error.reason).toBe("not-found");
        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual(
          expect.arrayContaining(
            operation === "getIssue" || operation === "update-body"
              ? ["devops", "invoke", "workitemsbatch", "POST"]
              : ["boards", "work-item", "show"],
          ),
        );
      }),
  );

  it.effect.each(["web app", "a0000000-0000-0000-0000-000000000001"])(
    "accepts the native project identity for configured scope %s before writing",
    (project) =>
      Effect.gen(function* () {
        const seen: ReadonlyArray<string>[] = [];
        const api = yield* tracker((args) => {
          seen.push(args);
          if (args.slice(0, 3).join(" ") === "devops project show")
            return encode({ id: "a0000000-0000-0000-0000-000000000001", name: "Web App" });
          return answer(args);
        });
        yield* api.update!({
          cwd: "/w",
          host: "dev.azure.com",
          scope: `acme/${project}`,
          key: "7",
          title: "Changed title",
        });
        expect(seen[0]).toEqual(expect.arrayContaining(["boards", "work-item", "show"]));
        expect(seen.at(-1)?.slice(0, 3)).toEqual(["boards", "work-item", "update"]);
        expect(seen).toHaveLength(project === "web app" ? 2 : 3);
      }),
  );

  it.effect("refuses a scope that is not organization/project without a request", () =>
    Effect.gen(function* () {
      let requests = 0;
      const api = yield* tracker(() => {
        requests += 1;
        return "{}";
      });
      const error = yield* Effect.flip(
        api.getIssue({ cwd: "/w", host: "dev.azure.com", scope: "web", key: "7" }),
      );
      expect(error.reason).toBe("failed");
      expect(requests).toBe(0);
    }),
  );
});

it.effect.each(["asc", "desc"] as const)(
  "reads true Azure comment and revision windows in %s order",
  (order) =>
    Effect.gen(function* () {
      const rows = Array.from({ length: 223 }, (_, index) => ({
        id: index + 1,
        text: String(index + 1),
        format: "markdown",
        createdDate: `2026-10-${String(14 + Math.floor(index / 60)).padStart(2, "0")}T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
        revisedDate: `2026-10-${String(14 + Math.floor(index / 60)).padStart(2, "0")}T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
        fields: { "System.Title": { oldValue: "old", newValue: String(index + 1) } },
      }));
      const calls: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        calls.push(args);
        if (args.includes("updates")) {
          const skip = Number(args.find((arg) => arg.startsWith("$skip="))?.slice(6) ?? 0);
          const top = Number(args.find((arg) => arg.startsWith("$top="))?.slice(5));
          return encode({ value: rows.slice(skip, skip + top) });
        }
        if (args.includes("comments")) {
          expect(args).toContain(`order=${order}`);
          const offset = Number(
            args.find((arg) => arg.startsWith("continuationToken="))?.slice(18) ?? 0,
          );
          const sorted = order === "desc" ? rows.toReversed() : rows;
          return encode({
            comments: sorted.slice(offset, offset + 100),
            count: Math.min(100, rows.length - offset),
            totalCount: rows.length,
            ...(offset + 100 < rows.length ? { continuationToken: String(offset + 100) } : {}),
          });
        }
        return encode({ ...WORK_ITEM, rev: rows.length, relations: [] });
      });
      const selected = {
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
        connectionId: "account-a",
        order,
      };
      for (const kind of ["comments", "history"] as const) {
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
          const before = calls.length;
          const page =
            kind === "comments"
              ? yield* api.getComments({ ...selected, ...(cursor === undefined ? {} : { cursor }) })
              : yield* api.getHistory!({
                  ...selected,
                  limit: 100,
                  ...(cursor === undefined ? {} : { cursor }),
                });
          expect(calls.length - before).toBe(2);
          ids.push(
            ...("comments" in page
              ? page.comments.map((row) => row.id)
              : page.items.map((row) => row.id.split("-")[1]!)),
          );
          cursor = page.nextCursor ?? undefined;
          if (cursor !== undefined) {
            for (const changed of [
              { connectionId: "account-b" },
              { order: order === "desc" ? ("asc" as const) : ("desc" as const) },
              { cwd: "/other" },
              { scope: "acme/Other" },
              { key: "8" },
              { host: "other.visualstudio.com" },
            ]) {
              const count = calls.length;
              const bad = { ...selected, ...changed, cursor };
              if (kind === "comments") yield* api.getComments(bad).pipe(Effect.flip);
              else yield* api.getHistory!(bad).pipe(Effect.flip);
              expect(calls).toHaveLength(count);
            }
            const parsed: Record<string, unknown> = JSON.parse(cursor);
            for (const position of [-1, 0, Number(parsed.total)]) {
              const before = calls.length;
              const bad = { ...selected, cursor: JSON.stringify({ ...parsed, position }) };
              if (kind === "comments") yield* api.getComments(bad).pipe(Effect.flip);
              else yield* api.getHistory!(bad).pipe(Effect.flip);
              expect(calls).toHaveLength(before);
            }
          }
        } while (cursor !== undefined);
        expect(ids).toEqual(
          (order === "desc" ? rows.toReversed() : rows)
            .filter((row) => kind === "comments" || row.id !== 1)
            .map((row) => String(row.id)),
        );
        expect(new Set(ids).size).toBe(kind === "comments" ? 223 : 222);
      }
      for (const cursor of ["0", "50", "{}", "null", "[]"]) {
        const before = calls.length;
        yield* api.getComments({ ...selected, cursor }).pipe(Effect.flip);
        yield* api.getHistory!({ ...selected, cursor }).pipe(Effect.flip);
        expect(calls).toHaveLength(before);
      }
    }),
);

it.effect.each([
  { comments: [], continuationToken: "next" },
  { comments: [], totalCount: 2 },
  { comments: [{ id: 2, createdDate: "2026-10-14T01:00:00Z" }], count: 1, totalCount: 2 },
  { comments: [{ id: 2, createdDate: "2026-10-14T01:00:00Z" }], count: 2 },
  { comments: [1, 2].map((id) => ({ id, createdDate: `2026-10-14T0${id}:00:00Z` })) },
])("refuses inconsistent Azure native comment pages: %j", (page) =>
  Effect.gen(function* () {
    const calls: ReadonlyArray<string>[] = [];
    const api = yield* tracker((args) => {
      calls.push(args);
      return args.includes("comments") ? encode(page) : encode(WORK_ITEM);
    });
    const error = yield* api
      .getComments({ cwd: "/w", host: "dev.azure.com", scope: "acme/Web App", key: "7" })
      .pipe(Effect.flip);
    expect(error.reason).toBe("failed");
    expect(calls).toHaveLength(2);
  }),
);

it.effect.each([null, 0, 1.5, 9007199254740992])(
  "refuses an absent or invalid Azure revision %s before an update read",
  (rev) =>
    Effect.gen(function* () {
      const calls: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        calls.push(args);
        return encode({ ...WORK_ITEM, ...(rev === null ? { rev: undefined } : { rev }) });
      });
      yield* api.getHistory!({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
      }).pipe(Effect.flip);
      expect(calls).toHaveLength(1);
    }),
);

it.effect.each([[], [1, 1], [2, 3], [1]])(
  "refuses missing, repeated or foreign Azure update windows: %j",
  (ids) =>
    Effect.gen(function* () {
      const calls: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        calls.push(args);
        return args.includes("updates")
          ? encode({ value: ids.map((id) => ({ id, revisedDate: "2026-10-14T01:00:00Z" })) })
          : encode(WORK_ITEM);
      });
      yield* api.getHistory!({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
      }).pipe(Effect.flip);
      expect(calls).toHaveLength(2);
    }),
);

it.effect("rejects a repeated Azure comment token without another continuation read", () =>
  Effect.gen(function* () {
    const calls: ReadonlyArray<string>[] = [];
    let id = 3;
    const api = yield* tracker((args) => {
      calls.push(args);
      return args.includes("comments")
        ? encode({
            comments: [{ id: id--, createdDate: "2026-10-14T01:00:00Z" }],
            continuationToken: "repeated",
          })
        : encode(WORK_ITEM);
    });
    const target = { cwd: "/w", host: "dev.azure.com", scope: "acme/Web App", key: "7" };
    const first = yield* api.getComments(target);
    yield* api.getComments({ ...target, cursor: first.nextCursor! }).pipe(Effect.flip);
    expect(calls).toHaveLength(4);
  }),
);

it.effect("starts Azure detail at the true newest comment and revision pages", () =>
  Effect.gen(function* () {
    const rows = Array.from({ length: 223 }, (_, index) => ({
      id: index + 1,
      text: String(index + 1),
      createdDate: "2026-10-14T01:00:00Z",
      revisedDate: "2026-10-14T01:00:00Z",
      fields: { "System.Title": { oldValue: "old", newValue: String(index + 1) } },
    }));
    const calls: ReadonlyArray<string>[] = [];
    const api = yield* tracker((args) => {
      calls.push(args);
      if (args.includes("comments")) {
        expect(args).toContain("order=desc");
        return encode({ comments: rows.slice(-100).toReversed(), continuationToken: "older" });
      }
      if (args.includes("updates")) {
        expect(args).toContain("$skip=123");
        expect(args).toContain("$top=100");
        return encode({ value: rows.slice(-100) });
      }
      return encode({ ...WORK_ITEM, rev: 223, relations: [] });
    });
    const result = yield* api.getIssue({
      cwd: "/w",
      host: "dev.azure.com",
      scope: "acme/Web App",
      key: "7",
      connectionId: "selected-account",
    });
    expect(result.comments.map((row) => row.id)).toEqual(
      rows
        .slice(-100)
        .toReversed()
        .map((row) => String(row.id)),
    );
    expect(result.events.map((row) => row.detail)).toEqual(
      rows
        .slice(-100)
        .toReversed()
        .map((row) => String(row.id)),
    );
    expect(result.historyTruncated).toBe(true);
    expect(result.commentsCursor).toContain("selected-account");
    expect(calls).toHaveLength(3);
    expect(calls.flat()).not.toContain("profiles");
  }),
);
