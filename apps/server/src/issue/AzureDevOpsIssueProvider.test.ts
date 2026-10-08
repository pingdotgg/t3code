import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { ChildProcessSpawner } from "effect/process";

import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import * as AzureDevOpsIssueCli from "./AzureDevOpsIssueCli.ts";
import * as AzureDevOpsIssueProvider from "./AzureDevOpsIssueProvider.ts";
import { decodeWorkItemJson, decodeWorkItemsJson } from "./azureDevOpsIssueJson.ts";

it.effect("reads modern and legacy Azure work item URLs in lists and details", () =>
  Effect.gen(function* () {
    for (const [url, expectedUrl] of [
      [
        "https://dev.azure.com/acme/_apis/wit/workItems/7",
        "https://dev.azure.com/acme/_workitems/edit/7",
      ],
      [
        "https://dev.azure.com/acme/web/_apis/wit/workItems/7",
        "https://dev.azure.com/acme/_workitems/edit/7",
      ],
      [
        "https://acme.visualstudio.com/_apis/wit/workItems/7",
        "https://acme.visualstudio.com/_workitems/edit/7",
      ],
      [
        "https://acme.visualstudio.com/web/_apis/wit/workItems/7",
        "https://acme.visualstudio.com/web/_workitems/edit/7",
      ],
      [
        "https://acme.visualstudio.com/DefaultCollection/web/_apis/wit/workItems/7",
        "https://acme.visualstudio.com/DefaultCollection/_workitems/edit/7",
      ],
      [
        "https://azure.example.com/collection/web/_apis/wit/workItems/7",
        "https://azure.example.com/collection/_workitems/edit/7",
      ],
    ]) {
      const item = {
        id: 7,
        url,
        fields: {
          "System.Title": "Work item 7",
          "System.CreatedDate": "2026-07-01T00:00:00Z",
          "System.Description": "Work item body",
        },
      };
      const provider = yield* AzureDevOpsIssueProvider.make.pipe(
        Effect.provide(
          AzureDevOpsIssueCli.layer.pipe(
            Layer.provide(
              Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
                execute: ({ args }) =>
                  Effect.succeed({
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout:
                      args[0] === "repos"
                        ? "web\n"
                        : JSON.stringify(args[1] === "query" ? [item] : item),
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  }),
              }),
            ),
          ),
        ),
      );
      const reference = { cwd: "/repo", repository: "acme/web", host: "dev.azure.com" };
      const page = yield* provider.listIssues({
        ...reference,
        state: "all",
        involvement: "all",
        viewer: "ada",
        limit: 20,
      });
      assert.deepStrictEqual(
        page.items.map((issue) => ({ number: issue.number, title: issue.title, url: issue.url })),
        [{ number: 7, title: "Work item 7", url: expectedUrl }],
      );
      const detail = yield* provider.getIssue({ ...reference, number: 7 });
      assert.strictEqual(detail.url, expectedUrl);
      assert.strictEqual(detail.body, "Work item body");
    }
  }),
);

it("rejects malformed and non-HTTP work item URLs in lists and details", () => {
  for (const url of [
    "not a URL",
    "javascript://acme.visualstudio.com/_apis/wit/workItems/7",
    "https://acme.visualstudio.com.evil.test/_apis/wit/workItems/7",
    "https://dev.azure.com/_apis/wit/workItems/7",
    "https://acme.visualstudio.com/_apis/git/repositories/7",
  ]) {
    const item = {
      id: 7,
      url,
      fields: {
        "System.Title": "Work item 7",
        "System.CreatedDate": "2026-07-01T00:00:00Z",
      },
    };
    assert.deepStrictEqual(
      decodeWorkItemsJson(JSON.stringify([item])),
      Result.succeed({ items: [] }),
    );
    assert.deepStrictEqual(decodeWorkItemJson(JSON.stringify(item)), Result.succeed(null));
  }
});

it.effect("maps CLI rate limits without changing other Azure DevOps failures", () =>
  Effect.gen(function* () {
    const context = {
      operation: "execute" as const,
      command: "az" as const,
      cwd: "/repo",
      argumentCount: 1,
      cause: new Error("provider failure"),
    };
    for (const [source, reason] of [
      [new AzureDevOpsCli.AzureDevOpsCliRateLimitError(context), "rate-limited"],
      [new AzureDevOpsCli.AzureDevOpsCliUnavailableError(context), "missing-tool"],
      [new AzureDevOpsCli.AzureDevOpsCliAuthenticationError(context), "unauthenticated"],
      [new AzureDevOpsCli.AzureDevOpsCommandFailedError(context), "failed"],
    ] as const) {
      const provider = yield* AzureDevOpsIssueProvider.make.pipe(
        Effect.provide(
          Layer.mock(AzureDevOpsIssueCli.AzureDevOpsIssueCli)({
            listWorkItems: () => Effect.fail(source),
            runWorkItemAction: () => Effect.fail(source),
          }),
        ),
      );
      const reference = { cwd: "/repo", repository: "acme/web", host: "dev.azure.com" };
      for (const request of [
        provider.listIssues({
          ...reference,
          state: "open",
          involvement: "all",
          viewer: "ada",
          limit: 20,
        }),
        provider.runAction({ ...reference, number: 7, action: "close" }),
      ]) {
        const error = yield* Effect.flip(request);
        assert.strictEqual(error._tag, "IssueProviderError");
        assert.strictEqual(error.provider, "azure-devops");
        assert.strictEqual(error.reason, reason);
        assert.strictEqual(error.retryAt, undefined);
        assert.strictEqual(error.detail, source.detail);
        assert.strictEqual(error.cause, source);
      }
    }
  }),
);
