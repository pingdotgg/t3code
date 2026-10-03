import { assert, describe, it } from "@effect/vitest";

import { renderWebhookPrompt, type WebhookRequest } from "./webhookTemplate.ts";

const githubPullRequest: WebhookRequest = {
  method: "POST",
  path: "/api/hooks/task-1",
  query: "source=github",
  headers: { "content-type": "application/json", "x-github-event": "pull_request" },
  bodyText: JSON.stringify({
    action: "opened",
    pull_request: { url: "https://github.com/org/repo/pull/45", number: 45, labels: ["bug"] },
  }),
};

describe("renderWebhookPrompt", () => {
  it("sends only what the template names", () => {
    const rendered = renderWebhookPrompt(
      "Review this PR: {{body.pull_request.url}}",
      githubPullRequest,
    );
    assert.equal(rendered.prompt, "Review this PR: https://github.com/org/repo/pull/45");
    assert.deepEqual(rendered.missing, []);
  });

  it("reads headers case-insensitively, query parameters and array indexes", () => {
    const rendered = renderWebhookPrompt(
      "{{ headers.X-GitHub-Event }} #{{body.pull_request.number}} {{body.pull_request.labels.0}} {{query.source}}",
      githubPullRequest,
    );
    assert.equal(rendered.prompt, "pull_request #45 bug github");
  });

  it("renders objects as JSON and the raw body and request on request", () => {
    const rendered = renderWebhookPrompt(
      "{{body.pull_request.labels}}|{{body}}",
      githubPullRequest,
    );
    assert.equal(rendered.prompt, `[\n  "bug"\n]|${githubPullRequest.bodyText}`);
    const request = renderWebhookPrompt("{{request}}", githubPullRequest).prompt;
    assert.isTrue(request.startsWith("POST /api/hooks/task-1?source=github\n"));
    assert.include(request, "x-github-event: pull_request");
    assert.isTrue(request.endsWith(githubPullRequest.bodyText));
  });

  it("renders missing fields empty and reports them once", () => {
    const rendered = renderWebhookPrompt(
      "a={{body.nope}} b={{body.nope}} c={{headers.x-missing}} d={{unknown}}",
      githubPullRequest,
    );
    assert.equal(rendered.prompt, "a= b= c= d=");
    assert.deepEqual(rendered.missing, ["body.nope", "headers.x-missing", "unknown"]);
  });

  it("addresses form-encoded bodies and leaves other bodies to {{body}}", () => {
    const form = renderWebhookPrompt("{{body.text}} by {{body.user_name}}", {
      ...githubPullRequest,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      bodyText: "text=deploy+prod&user_name=alice",
    });
    assert.equal(form.prompt, "deploy prod by alice");

    const plain = renderWebhookPrompt("{{body.field}}{{body}}", {
      ...githubPullRequest,
      headers: { "content-type": "text/plain" },
      bodyText: "build failed",
    });
    assert.equal(plain.prompt, "build failed");
    assert.deepEqual(plain.missing, ["body.field"]);
  });

  it("does not resolve inherited object properties", () => {
    const rendered = renderWebhookPrompt(
      "{{body.constructor}}{{body.__proto__}}",
      githubPullRequest,
    );
    assert.equal(rendered.prompt, "");
  });
});
