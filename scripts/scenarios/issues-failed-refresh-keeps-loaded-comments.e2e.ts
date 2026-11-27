/// <reference lib="dom" />
import type { IssueComment, IssueDetail, IssueRef } from "@t3tools/contracts";
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A failed issue refresh keeps the older comments already loaded",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    await browser.addInitScript(() => {
      let rateLimited = false;
      Object.assign(window, {
        armIssueRefreshFailure: () => {
          rateLimited = true;
        },
      });
      const refresh = new Promise<void>((resolve) => {
        Object.assign(window, { releaseIssueRefresh: () => resolve() });
      });
      const comment = (id: string, body: string, day: string): IssueComment => ({
        id,
        body,
        author: null,
        createdAt: `2026-10-${day}T00:00:00.000Z`,
        url: null,
      });
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const request: {
          _tag: string;
          id: string;
          tag: string;
          payload: IssueRef & { cursor?: string };
        } | null = typeof data === "string" ? JSON.parse(data) : null;
        if (request?._tag !== "Request") return send.call(this, data);
        const reply = (exit: unknown) =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ _tag: "Exit", requestId: request.id, exit }),
            }),
          );
        if (request.tag === "issues.comments" && request.payload.cursor === "older-page") {
          queueMicrotask(() =>
            reply({
              _tag: "Success",
              value: {
                comments: [comment("older", "Older comment already read", "01")],
                nextCursor: null,
              },
            }),
          );
          return;
        }
        if (request.tag !== "issues.detail") return send.call(this, data);
        if (rateLimited) {
          void refresh.then(() =>
            reply({
              _tag: "Failure",
              cause: [
                {
                  _tag: "Fail",
                  error: {
                    _tag: "IssueOperationError",
                    operation: "detail",
                    detail: "GitHub API rate limit exceeded.",
                    reason: "rate-limited",
                  },
                },
              ],
            }),
          );
          return;
        }
        const { projectId, tracker, scope, key } = request.payload;
        const detail: IssueDetail = {
          projectId,
          tracker,
          scope,
          key,
          host: "github.com",
          displayKey: "#42",
          projectTitle: "demo",
          title: "Issue before the rate limit",
          body: "The details from the last successful read.",
          url: "https://github.com/example/demo/issues/42",
          author: null,
          state: { category: "open", name: "Open" },
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
          closedAt: null,
          assignees: [],
          labels: [],
          commentCount: 101,
          writable: false,
          capabilities: {
            create: false,
            edit: false,
            comment: false,
            labels: false,
            assignees: false,
            reactions: false,
            templates: false,
            linkedPullRequests: false,
            events: false,
            search: true,
          },
          viewerPermissions: {
            setState: false,
            comment: false,
            edit: false,
            labels: false,
            assignees: false,
          },
          states: [],
          viewer: null,
          comments: [comment("newest", "Newest comment", "02")],
          commentsCursor: "older-page",
          events: [],
          linkedPullRequests: [],
        };
        queueMicrotask(() => reply({ _tag: "Success", value: detail }));
      };
    });

    await t3.open("/issues?selectedProjectId=demo&tracker=github&scope=example/demo&key=42");
    const loadOlder = screen.getByRole("button", "Load older comments", { exact: true });
    const loadedComment = screen.getByText("Older comment already read", { exact: true });
    await loadOlder.waitFor({ timeout: 60_000 });
    await loadOlder.tap();
    await loadedComment.waitFor();
    await browser.evaluate(() => {
      (window as unknown as { armIssueRefreshFailure: () => void }).armIssueRefreshFailure();
      return null;
    });
    await screen.getByRole("button", "Refresh issue", { exact: true }).tap();
    const refreshing = browser.locator('button[aria-label="Refresh issue"]:disabled');
    await refreshing.waitFor();
    await browser.evaluate(() => {
      (window as unknown as { releaseIssueRefresh: () => void }).releaseIssueRefresh();
      return null;
    });
    await refreshing.waitFor({ state: "hidden" });
    await screen.getByText("GitHub API rate limit exceeded.", { exact: false }).waitFor();
    await screen.getByText("Newest comment", { exact: true }).waitFor();
    const activity = 'section[aria-label^="Activity"]';
    await browser.evaluate((selector) => {
      document.querySelector(selector)?.scrollIntoView({ block: "start" });
      return null;
    }, activity);
    await app.screenshot("activity-after-failed-refresh");
    await expect(browser.locator(activity)).toContainText("Older comment already read");
  },
);
