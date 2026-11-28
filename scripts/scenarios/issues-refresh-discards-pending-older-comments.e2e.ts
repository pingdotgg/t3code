/// <reference lib="dom" />
import type { IssueComment, IssueCommentsPage, IssueDetail, IssueRef } from "@t3tools/contracts";
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A page requested before refreshing an issue does not restore old comments",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    await browser.addInitScript(() => {
      const pendingPage = new Promise<void>((resolve) => {
        Object.assign(window, { releaseOldIssuePage: () => resolve() });
      });
      const comment = (id: string, body: string, day: string): IssueComment => ({
        id,
        body,
        author: null,
        createdAt: `2026-10-${day}T00:00:00.000Z`,
        url: null,
      });
      let refreshed = false;
      let pendingRefresh: Promise<void> | undefined;
      Object.assign(window, {
        armIssueRefresh: () => {
          refreshed = true;
        },
        holdIssueRefresh: () => {
          const { promise, resolve } = Promise.withResolvers<void>();
          pendingRefresh = promise;
          Object.assign(window, { releaseIssueRefresh: resolve });
        },
      });
      // Keep the real socket for all other RPCs. Supply three pages of an unchanged GitHub
      // comment history and hold the last page until the refreshed detail has rendered.
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const request: {
          _tag: string;
          id: string;
          tag: string;
          payload: IssueRef & { cursor?: string };
        } | null = typeof data === "string" ? JSON.parse(data) : null;
        if (request?._tag !== "Request") return send.call(this, data);
        const reply = (value: IssueDetail | IssueCommentsPage) =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                _tag: "Exit",
                requestId: request.id,
                exit: { _tag: "Success", value },
              }),
            }),
          );
        if (request.tag === "issues.detail") {
          const { projectId, tracker, scope, key } = request.payload;
          const detail: IssueDetail = {
            projectId,
            tracker,
            scope,
            key,
            host: "github.com",
            displayKey: "#42",
            projectTitle: "demo",
            title: refreshed ? "Pagination issue after refresh" : "Pagination issue",
            body: "Comment history",
            url: "https://github.com/example/demo/issues/42",
            author: null,
            state: { category: "open", name: "Open" },
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-04T00:00:00.000Z",
            closedAt: null,
            assignees: [],
            labels: [],
            commentCount: 201,
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
            comments: [comment("newest", "Newest comment", "04")],
            commentsCursor: "first-older-page",
            events: [],
            linkedPullRequests: [],
          };
          if (pendingRefresh) {
            void pendingRefresh.then(() => reply(detail));
            pendingRefresh = undefined;
            return;
          }
          queueMicrotask(() => reply(detail));
        } else if (request.tag === "issues.comments") {
          if (request.payload.cursor === "first-older-page") {
            queueMicrotask(() =>
              reply({
                comments: [comment("older", "First older comment", "03")],
                nextCursor: "last-page",
              }),
            );
          } else if (request.payload.cursor === "last-page") {
            void pendingPage.then(() =>
              reply({
                comments: [comment("oldest", "Oldest comment", "02")],
                nextCursor: null,
              }),
            );
          } else return send.call(this, data);
        } else return send.call(this, data);
      };
    });

    await t3.open("/issues?selectedProjectId=demo&tracker=github&scope=example/demo&key=42");
    const loadOlder = screen.getByRole("button", "Load older comments", { exact: true });
    // The issues route compiles on first open, which can outlast the 30 s action timeout.
    await loadOlder.waitFor({ timeout: 60_000 });
    await loadOlder.tap();
    await screen.getByText("First older comment", { exact: true }).waitFor();
    await loadOlder.tap();
    const loading = screen.getByRole("button", "Loading…", { exact: true });
    await loading.waitFor();
    await browser.evaluate(() => {
      (window as unknown as { armIssueRefresh: () => void }).armIssueRefresh();
      return null;
    });
    await screen.getByRole("button", "Refresh issue", { exact: true }).tap();
    await screen.getByText("Pagination issue after refresh", { exact: true }).waitFor();

    await browser.evaluate(() => {
      (window as unknown as { releaseOldIssuePage: () => void }).releaseOldIssuePage();
      return null;
    });
    const activity = 'section[aria-label^="Activity"]';
    await loading.waitFor({ state: "hidden" });
    await browser.evaluate((selector) => {
      document.querySelector(selector)?.scrollIntoView({ block: "start" });
      return null;
    }, activity);
    await app.screenshot("activity-after-refresh-and-late-page");
    await expect(browser.locator(activity)).not.toContainText("First older comment");

    await browser.evaluate(() => {
      (window as unknown as { holdIssueRefresh: () => void }).holdIssueRefresh();
      return null;
    });
    const refresh = screen.getByRole("button", "Refresh issue", { exact: true });
    await refresh.tap();
    await expect(refresh).toBeDisabled();
    await expect(loadOlder).toBeDisabled();
    await browser.evaluate(() => {
      (window as unknown as { releaseIssueRefresh: () => void }).releaseIssueRefresh();
      return null;
    });
    await expect(loadOlder).toBeEnabled();
    await loadOlder.tap();
    await screen.getByText("First older comment", { exact: true }).waitFor();
  },
);
