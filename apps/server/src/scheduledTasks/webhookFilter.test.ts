import { assert, describe, it } from "@effect/vitest";
import type { ScheduledTaskWebhookFilter } from "@t3tools/contracts";

import { findFailedWebhookFilter, matchesWebhookFilter } from "./webhookFilter.ts";
import type { WebhookRequest } from "./webhookTemplate.ts";

const request: WebhookRequest = {
  method: "POST",
  path: "/api/hooks/task-1",
  query: "source=github",
  headers: { "content-type": "application/json", "x-github-event": "pull_request" },
  bodyText: JSON.stringify({
    action: "labeled",
    number: 45,
    draft: false,
    closed_at: null,
    label: { name: "agent:review" },
    labels: ["bug"],
  }),
};

const matches = (filter: ScheduledTaskWebhookFilter) =>
  findFailedWebhookFilter([filter], request) === null;

describe("matchesWebhookFilter", () => {
  it("compares scalars as strings", () => {
    assert.isTrue(matches({ path: "body.action", op: "equals", value: "labeled" }));
    assert.isTrue(matches({ path: "body.number", op: "equals", value: "45" }));
    assert.isTrue(matches({ path: "body.draft", op: "equals", value: "false" }));
    assert.isFalse(matches({ path: "body.action", op: "equals", value: "Labeled" }));
    assert.isTrue(matches({ path: "body.action", op: "notEquals", value: "closed" }));
    assert.isFalse(matches({ path: "body.action", op: "notEquals", value: "labeled" }));
    assert.isTrue(matches({ path: "body.action", op: "in", value: ["opened", "labeled"] }));
    assert.isTrue(matches({ path: "body.label.name", op: "startsWith", value: "agent:" }));
    assert.isFalse(matches({ path: "body.label.name", op: "startsWith", value: "review" }));
  });

  it("reads headers case-insensitively and query values by name", () => {
    assert.isTrue(matches({ path: "headers.X-GitHub-Event", op: "equals", value: "pull_request" }));
    assert.isTrue(matches({ path: "query.source", op: "equals", value: "github" }));
  });

  it("lets objects and arrays satisfy only exists", () => {
    for (const path of ["body.label", "body.labels"]) {
      assert.isTrue(matches({ path, op: "exists" }));
      assert.isFalse(matches({ path, op: "equals", value: "[object Object]" }));
      assert.isFalse(matches({ path, op: "notEquals", value: "anything" }));
      assert.isFalse(matches({ path, op: "in", value: ["bug"] }));
      assert.isFalse(matches({ path, op: "startsWith", value: "" }));
    }
  });

  it("fails every op on a missing or null path, including notEquals", () => {
    for (const path of [
      "body.missing",
      "body.label.name.deeper",
      "headers.x-none",
      "body.closed_at",
    ]) {
      assert.isFalse(matches({ path, op: "exists" }));
      assert.isFalse(matches({ path, op: "notEquals", value: "x" }));
      assert.isFalse(matchesWebhookFilter({ path, op: "startsWith", value: "" }, undefined));
    }
  });
});

describe("findFailedWebhookFilter", () => {
  it("passes with no filters and reports the first failing filter", () => {
    assert.isNull(findFailedWebhookFilter([], request));
    assert.deepEqual(
      findFailedWebhookFilter(
        [
          { path: "headers.x-github-event", op: "equals", value: "pull_request" },
          { path: "body.action", op: "equals", value: "opened" },
          { path: "body.missing", op: "exists" },
        ],
        request,
      ),
      { index: 1, path: "body.action" },
    );
  });

  it("does not need a JSON body for header filters", () => {
    assert.isNull(
      findFailedWebhookFilter([{ path: "headers.x-github-event", op: "exists" }], {
        ...request,
        bodyText: "not json",
      }),
    );
  });
});
