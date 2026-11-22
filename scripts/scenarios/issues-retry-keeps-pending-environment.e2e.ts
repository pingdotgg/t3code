/// <reference lib="dom" />
import type { IssueListResult } from "@t3tools/contracts";
import { expect } from "e2e";

import { SECOND_HOME, startSecondServer } from "./second-server.ts";
import { makeState, test, WEB } from "./t3.ts";

test(
  "Retrying a failed environment keeps the Issues refresh already in progress",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("demo");
    const server = startSecondServer(app.baseUrl ?? "");
    try {
      const { host, token } = await server.ready;
      await makeState(SECOND_HOME).state.project("remote-demo");
      await browser.addInitScript((remoteHost) => {
        const { promise: slowRead, resolve: release } = Promise.withResolvers<void>();
        let refreshing = false;
        let primaryRefreshStarted = false;
        let remoteRefreshStarted = false;
        Object.assign(window, {
          armIssuesRefresh: () => {
            refreshing = true;
          },
          releaseSlowIssuesRead: release,
        });
        const date = "2026-10-01T00:00:00.000Z";
        const tracker = "github" as IssueListResult["trackers"][number]["tracker"];
        const list = (title: string, remote: boolean): IssueListResult => {
          const key = remote ? "2" : "1";
          return {
            entries: [
              {
                tracker,
                host: "github.com",
                scope: "example/demo",
                key,
                displayKey: "#" + key,
                title,
                projectId: (remote
                  ? "remote-demo"
                  : "demo") as IssueListResult["entries"][number]["projectId"],
                projectTitle: remote ? "remote-demo" : "demo",
                url: "https://github.com/example/demo/issues/" + key,
                author: null,
                state: { category: "open", name: "Open" },
                createdAt: date,
                updatedAt: date,
                closedAt: null,
                assignees: [],
                labels: [],
                commentCount: 0,
              },
            ],
            errors: [],
            nextCursors: {},
            viewers: {},
            trackers: [
              {
                tracker,
                host: "github.com",
                projectCount: 1,
                capabilities: null,
                configured: true,
                detail: null,
              },
            ],
          };
        };
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          const request: { _tag: string; id: string; tag: string } | null =
            typeof data === "string" ? JSON.parse(data) : null;
          if (request?._tag !== "Request" || request.tag !== "issues.list")
            return send.call(this, data);
          const remote = new URL(this.url).host === remoteHost;
          const reply = (exit: unknown) =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({ _tag: "Exit", requestId: request.id, exit }),
              }),
            );
          const success = (title: string) => reply({ _tag: "Success", value: list(title, remote) });

          if (!refreshing) {
            queueMicrotask(() =>
              success(remote ? "Issue from the linked environment" : "Before refresh"),
            );
          } else if (remote && !remoteRefreshStarted) {
            remoteRefreshStarted = true;
            queueMicrotask(() =>
              reply({
                _tag: "Failure",
                cause: [
                  {
                    _tag: "Fail",
                    error: {
                      _tag: "IssueOperationError",
                      operation: "list",
                      detail: "The linked environment could not list issues.",
                    },
                  },
                ],
              }),
            );
          } else if (remote) {
            queueMicrotask(() => success("Issues recovered on the linked environment"));
          } else if (!primaryRefreshStarted) {
            primaryRefreshStarted = true;
            // Only the original slow read is allowed to finish. Restarting it strands its result.
            void slowRead.then(() => success("Updated issue from the slow environment"));
          }
        };
      }, new URL(host).host);

      await t3.open("/settings/connections");
      await screen.getByRole("button", "Add environment").tap();
      const dialog = screen.getByRole("dialog");
      await dialog.getByPlaceholder("backend.example.com").fill(host);
      await dialog.getByPlaceholder("PAIRCODE").fill(token);
      await dialog.getByRole("button", "Add environment").tap();
      await screen.getByRole("button", "More actions for Scenario").waitFor({ timeout: 60_000 });
      await app.open("/issues");

      await screen.getByText("Before refresh", { exact: true }).waitFor({ timeout: 60_000 });
      await screen.getByText("Issue from the linked environment", { exact: true }).waitFor();
      await browser.evaluate(() => {
        (window as unknown as { armIssuesRefresh: () => void }).armIssuesRefresh();
        return null;
      });
      await screen.getByRole("button", "Refresh issues", { exact: true }).tap();
      await screen.getByText(/Showing the issues that loaded/).waitFor();
      await screen.getByRole("button", "Retry", { exact: true }).tap();
      await screen
        .getByText("Issues recovered on the linked environment", { exact: true })
        .waitFor();
      await browser.evaluate(() => {
        (window as unknown as { releaseSlowIssuesRead: () => void }).releaseSlowIssuesRead();
        return null;
      });
      try {
        await expect(
          screen.getByText("Updated issue from the slow environment", { exact: true }),
        ).toBeVisible();
      } finally {
        await app.screenshot("partial-issues-after-retry");
      }
    } finally {
      await server.stop();
    }
  },
);
