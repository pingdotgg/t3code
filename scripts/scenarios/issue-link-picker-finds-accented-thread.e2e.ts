/// <reference lib="dom" />
import type { IssueDetail, IssueRef } from "@t3tools/contracts";
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "The issue link picker finds a thread title without its accent",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    await t3.thread({ project, title: "Café planning", messages: ["first"] });
    await browser.addInitScript(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const request: { _tag: string; id: string; tag: string; payload: IssueRef } | null =
          typeof data === "string" ? JSON.parse(data) : null;
        if (request?._tag !== "Request" || request.tag !== "issues.detail")
          return send.call(this, data);
        const reply = (exit: unknown) =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ _tag: "Exit", requestId: request.id, exit }),
            }),
          );
        const { projectId, tracker, scope, key } = request.payload;
        const detail: IssueDetail = {
          projectId,
          tracker,
          scope,
          key,
          host: "github.com",
          displayKey: "#42",
          projectTitle: "demo",
          title: "Publish the release notes",
          body: "Check the release notes.",
          url: "https://github.com/example/demo/issues/42",
          author: null,
          state: { category: "open", name: "Open" },
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
          closedAt: null,
          assignees: [],
          labels: [],
          commentCount: 0,
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
            assignees: false,
            labels: false,
          },
          states: [],
          viewer: null,
          comments: [],
          commentsCursor: null,
          events: [],
          linkedPullRequests: [],
        };
        queueMicrotask(() => reply({ _tag: "Success", value: detail }));
      };
    });

    await t3.open("/issues?selectedProjectId=demo&tracker=github&scope=example/demo&key=42");
    await screen.getByText("Publish the release notes", { exact: true }).waitFor();
    await screen.getByRole("button", "Link to thread", { exact: true }).tap();
    const dialog = screen.getByRole("dialog", "Link issue to a thread");
    const thread = dialog.getByText("Café planning", { exact: true });
    await thread.waitFor();
    await dialog.getByPlaceholder("Search threads or projects...").fill("cafe");
    await app.screenshot("issue-link-thread-search");
    expect(await thread.isVisible(), "Searching for cafe keeps Café planning available").toBe(true);
  },
);
