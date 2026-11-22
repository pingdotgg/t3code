/// <reference lib="dom" />
import {
  ProjectSnapshot,
  SourceControlProviderKind,
  type PullRequestDetail,
  type PullRequestReviewGuideResult,
} from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

const repository = "scenario/demo";

const projectIn = Effect.fn("scenario.projectIn")(
  function* (origin: string, workspaceRoot: string) {
    const issued = yield* makeState(T3_HOME).cli(["auth", "session", "issue", "--token-only"]);
    const { projects } = yield* HttpClient.execute(
      HttpClientRequest.get(`${origin}/api/projects`).pipe(
        HttpClientRequest.bearerToken(issued.stdout.trim()),
      ),
    ).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ProjectSnapshot)),
    );
    const project = projects.find((entry) => entry.workspaceRoot === workspaceRoot);
    if (!project) throw new Error("Scenario project is missing.");
    const rpc = yield* rpcClient(T3_HOME, origin);
    yield* rpc["server.updateSettings"]({ patch: { reviewGuidesEnabled: true } });
    return project;
  },
  Effect.scoped,
  Effect.provide(FetchHttpClient.layer),
);

test(
  "The Guide tab reports that it lost access to a running guide",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const workspace = await t3.project("demo");
    const project = await runPromise(projectIn(app.baseUrl ?? "", workspace));
    const reference = { projectId: project.id, host: "gitlab.com", repository, number: 42 };
    const now = "2026-10-01T00:00:00.000Z";
    const detail = {
      provider: SourceControlProviderKind.make("gitlab"),
      ...reference,
      projectTitle: project.title,
      workspaceRoot: project.workspaceRoot,
      title: "Add release notes",
      body: "",
      url: `https://gitlab.com/${repository}/-/merge_requests/42`,
      author: null,
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      headBranch: "release-notes",
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      baseBranch: "main",
      createdAt: now,
      updatedAt: now,
      mergedAt: null,
      closedAt: null,
      reviewers: [],
      labels: [],
      checks: [],
      mergeCapabilities: { merge: false, squash: false, rebase: false },
      capabilities: {
        diff: true,
        comment: false,
        search: true,
        actions: [],
        mergeMethods: [],
        review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
        reviewers: { request: false, listCandidates: false },
      },
      viewerPermissions: {
        actions: [],
        comment: false,
        resolve: false,
        verdicts: [],
        requestReviewers: false,
      },
    } satisfies PullRequestDetail;

    const unavailable = "GitLab could not find this merge request.";
    await browser.addInitScript(
      ({ detail, unavailable }) => {
        const headSha = detail.headSha!;
        let guide: PullRequestReviewGuideResult = {
          guide: null,
          run: null,
          currentHeadSha: headSha,
        };
        let removed = false;
        Object.assign(window, {
          removeGuideAccess: () => {
            removed = true;
          },
          restoreGuideAccess: () => {
            removed = false;
          },
        });
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          const request: { _tag: string; id: string; tag: string } | null =
            typeof data === "string" ? JSON.parse(data) : null;
          if (request?._tag !== "Request") return send.call(this, data);
          const reply = (exit: unknown) =>
            queueMicrotask(() =>
              this.dispatchEvent(
                new MessageEvent("message", {
                  data: JSON.stringify({ _tag: "Exit", requestId: request.id, exit }),
                }),
              ),
            );
          const success = (value: unknown) => reply({ _tag: "Success", value });
          switch (request.tag) {
            case "pullRequests.list":
              return success({
                viewers: {},
                providers: [],
                entries: [],
                errors: [],
                truncated: false,
                nextCursors: {},
              });
            case "pullRequests.detail":
              return success(detail);
            case "pullRequests.activity":
              return success({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              });
            case "pullRequests.changeBreakdown":
              return success(null);
            case "pullRequests.generateReviewGuide":
              guide = {
                ...guide,
                run: { _tag: "Running", headSha, startedAt: detail.createdAt },
              };
              return success(guide);
            case "pullRequests.reviewGuide":
              if (!removed) return success(guide);
              document.documentElement.dataset.guideReadUnavailable = "true";
              return reply({
                _tag: "Failure",
                cause: [
                  {
                    _tag: "Fail",
                    error: {
                      _tag: "PullRequestOperationError",
                      operation: "detail",
                      detail: unavailable,
                      reason: "not-found",
                    },
                  },
                ],
              });
            default:
              return send.call(this, data);
          }
        };
      },
      { detail, unavailable },
    );

    const link = new URLSearchParams({
      repository,
      number: "42",
      selectedHost: reference.host,
      selectedProjectId: project.id,
    });
    await t3.open(`/pull-requests?${link}`);
    await screen.getByRole("button", "Guide", { exact: true }).tap();
    await screen.getByRole("button", "Write guide", { exact: true }).tap();
    await screen.getByText("Writing a review guide", { exact: true }).waitFor();
    await browser.evaluate(() => {
      (window as unknown as { removeGuideAccess: () => void }).removeGuideAccess();
      return null;
    });
    await browser
      .locator('html[data-guide-read-unavailable="true"]')
      .waitFor({ state: "attached", timeout: 15_000 });
    const error = screen.getByText(unavailable, { exact: false });
    try {
      await expect(error).toBeVisible();
    } finally {
      await app.screenshot("guide-after-losing-access");
    }
    await screen.getByRole("button", "More merge request actions", { exact: true }).tap();
    await expect(screen.getByRole("menuitem", "Write guide", { exact: true })).not.toBeVisible();
    await expect(
      screen.getByRole("menuitem", "Writing guide...", { exact: true }),
    ).not.toBeVisible();
    await browser.keyboard.press("Escape");

    await browser.evaluate(() => {
      (window as unknown as { restoreGuideAccess: () => void }).restoreGuideAccess();
      return null;
    });
    await expect(screen.getByText("Writing a review guide", { exact: true })).toBeVisible();
  },
);
