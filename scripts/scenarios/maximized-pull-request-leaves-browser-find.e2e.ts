/// <reference lib="dom" />
import { ProjectSnapshot } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const DESCRIPTION = "The review description should stay searchable with the browser find bar.";

test(
  "Cmd/Ctrl+F reaches the browser while a pull request is maximized",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const { projects } = await runPromise(
      Effect.gen(function* () {
        const issued = yield* makeState(T3_HOME).cli(["auth", "session", "issue", "--token-only"]);
        return yield* HttpClient.execute(
          HttpClientRequest.get(`${app.baseUrl}/api/projects`).pipe(
            HttpClientRequest.bearerToken(issued.stdout.trim()),
          ),
        ).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(ProjectSnapshot)),
        );
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    const projectId = projects.find((entry) => entry.workspaceRoot === project)!.id;
    await browser.addInitScript(
      ({ projectId, project, description }) => {
        const entry = {
          provider: "github",
          host: "github.com",
          projectId,
          projectTitle: "demo",
          repository: "example/demo",
          number: 42,
          title: "Keep the description searchable",
          url: "https://github.com/example/demo/pull/42",
          author: { login: "demo-author", name: null, avatarUrl: null },
          headBranch: "fix/search",
          baseBranch: "main",
          state: "open",
          isDraft: false,
          mergeability: "mergeable",
          additions: 12,
          deletions: 3,
          createdAt: "2026-11-20T12:00:00Z",
          updatedAt: "2026-11-20T12:00:00Z",
          viewerReviewRequested: false,
          labels: [],
        };
        const routing = {
          accountId: "demo",
          host: "github.com",
          provider: "github",
          viewer: "demo-viewer",
        };
        const responses: Record<string, unknown> = {
          "pullRequests.list": {
            viewers: { "github.com": "demo-viewer" },
            providers: [
              {
                host: "github.com",
                kind: "github",
                searchesOnHost: true,
                projectCount: 1,
                configured: true,
                detail: null,
                projectIds: [projectId],
              },
            ],
            entries: [entry],
            errors: [],
            truncated: false,
            nextCursors: {},
          },
          "pullRequests.detail": {
            ...entry,
            workspaceRoot: project,
            body: description,
            changedFiles: 1,
            mergedAt: null,
            closedAt: null,
            reviewers: [],
            checks: [],
            mergeCapabilities: { merge: false, squash: false, rebase: false },
            capabilities: {
              diff: false,
              comment: false,
              actions: [],
              mergeMethods: [],
              search: true,
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
          },
          "pullRequests.summary": entry,
          "pullRequests.preview": entry,
          "pullRequests.activity": {
            comments: [],
            commentCount: 0,
            commentsTruncated: false,
            reviewThreads: [],
            commits: [],
          },
          "pullRequests.checks": { state: "open", checks: [] },
          "pullRequests.listStats": { stats: [] },
          "pullRequests.filterOptions": {
            labels: [],
            authors: [],
            references: [],
            truncated: false,
          },
          "pullRequests.stack": null,
          "pullRequests.linkedThreads": { threads: [] },
          "pullRequests.routing": { ...routing, projectTitle: "demo", workspaceRoot: project },
          "pullRequests.routingIdentity": routing,
        };
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          const request: { _tag: string; id: string; tag: string } | null =
            typeof data === "string" ? JSON.parse(data) : null;
          if (request?._tag !== "Request" || !(request.tag in responses)) {
            return send.call(this, data);
          }
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  _tag: "Exit",
                  requestId: request.id,
                  exit: { _tag: "Success", value: responses[request.tag] },
                }),
              }),
            ),
          );
        };
      },
      { projectId, project, description: DESCRIPTION },
    );

    await t3.open("/pull-requests");
    await screen.getByRole("button", /^Open #42 /).tap();
    await screen.getByRole("button", "Maximize panel", { exact: true }).tap();
    await screen.getByText(DESCRIPTION).tap();
    await browser.evaluate(() => {
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "f") Object.assign(window, { findShortcut: event });
        },
        { capture: true },
      );
      return null;
    });
    await browser.keyboard.press("ControlOrMeta+f");
    await app.screenshot("maximized-find");
    expect(
      await browser.evaluate(
        () => (window as { findShortcut?: KeyboardEvent }).findShortcut?.defaultPrevented ?? null,
      ),
      "The app leaves Cmd/Ctrl+F to the browser's find bar",
    ).toBe(false);
  },
);
