/// <reference lib="dom" />
import type { IssueCandidates, IssueDetail, IssueRef } from "@t3tools/contracts";
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const PREFIX = "Issue operation update failed: ";
const KEPT = `${PREFIX}${"The tracker refused this label. ".repeat(10)}`.slice(0, 318);
// The emoji's two UTF-16 units straddle unit 319, where the toast's error is cut.
const DETAIL = `${KEPT.slice(PREFIX.length)}😀 and the rest of the error`;

test(
  "A long issue error copied from its toast ends without a broken character",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    await browser.addInitScript((failureDetail) => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const request: { _tag: string; id: string; tag: string; payload: IssueRef } | null =
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
            title: "Issue with a label to change",
            body: "",
            url: "https://github.com/example/demo/issues/42",
            author: null,
            state: { category: "open", name: "Open" },
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
            closedAt: null,
            assignees: [],
            labels: [],
            commentCount: 0,
            writable: true,
            capabilities: {
              create: false,
              edit: false,
              comment: false,
              labels: true,
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
              labels: true,
              assignees: false,
            },
            states: [],
            viewer: null,
            comments: [],
            commentsCursor: null,
            events: [],
            linkedPullRequests: [],
          };
          reply({ _tag: "Success", value: detail });
          return;
        }
        if (request.tag === "issues.candidates") {
          const value: IssueCandidates = {
            labels: [{ name: "bug", color: "d73a4a", description: null }],
            assignees: [],
            truncated: false,
          };
          reply({ _tag: "Success", value });
          return;
        }
        if (request.tag === "issues.update") {
          reply({
            _tag: "Failure",
            cause: [
              {
                _tag: "Fail",
                error: { _tag: "IssueOperationError", operation: "update", detail: failureDetail },
              },
            ],
          });
          return;
        }
        return send.call(this, data);
      };
    }, DETAIL);

    await t3.open("/issues?selectedProjectId=demo&tracker=github&scope=example/demo&key=42");
    await screen.getByRole("combobox", "Change labels", { exact: true }).tap();
    await screen.getByRole("option", "bug").tap();
    await browser.keyboard.press("Escape");

    // The toast shows four lines of a long error, so its end is read from what Copy error copies.
    await screen.getByRole("button", "Copy error", { exact: true }).tap();
    await screen.getByRole("button", "Copied error", { exact: true }).waitFor();
    const search = screen.getByRole("searchbox", "Search issues");
    await search.tap();
    await browser.keyboard.press("ControlOrMeta+v");
    await app.screenshot("pasted-error");
    await expect(search).toHaveValue(`${KEPT}…`);
  },
);
