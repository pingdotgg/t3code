import { expect, it, vi } from "vite-plus/test";

import { handleRequest, type GitHubEventsEnv } from "./app.ts";

const WEBHOOK_SECRET = "w".repeat(32);
const FEED_TOKEN = "f".repeat(32);

async function sign(body: Uint8Array, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, body.buffer as ArrayBuffer));
  return `sha256=${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

it("verifies, normalizes, and persists github webhook deliveries", async () => {
  const payload = {
    action: "created",
    repository: {
      id: 1,
      full_name: "pingdotgg/t3code",
      html_url: "https://github.com/pingdotgg/t3code",
    },
    sender: { id: 2, login: "contributor" },
    issue: {
      number: 42,
      title: "fix the thing",
      state: "open",
      locked: false,
      user: { id: 2, login: "contributor" },
      labels: [],
      pull_request: {
        url: "https://api.github.com/repos/pingdotgg/t3code/pulls/42",
        html_url: "https://github.com/pingdotgg/t3code/pull/42",
      },
    },
    comment: {
      id: 99,
      body: "please add a regression test",
      user: { id: 2, login: "contributor" },
    },
  };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  let forwarded: Request | undefined;
  const hubFetch = vi.fn(async (request: Request) => {
    forwarded = request;
    return new Response(null, { status: 201 });
  });
  const env = {
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_EVENTS_FEED_TOKEN: FEED_TOKEN,
    GITHUB_REPOSITORY: "pingdotgg/t3code",
    GITHUB_EVENT_HUB: {
      getByName: () => ({ fetch: hubFetch }),
    },
  } satisfies GitHubEventsEnv;

  const response = await handleRequest(
    new Request("https://events.example/v1/github/webhook", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "issue_comment",
        "x-hub-signature-256": await sign(body, WEBHOOK_SECRET),
      },
    }),
    env,
  );

  expect(response.status).toBe(202);
  expect(hubFetch).toHaveBeenCalledOnce();
  if (!forwarded) throw new Error("webhook was not forwarded");
  expect(await forwarded.json()).toMatchObject({
    deliveryId: "delivery-1",
    details: { comment: { body: "please add a regression test" } },
  });
});

it("authenticates and forwards resumable pull request feeds", async () => {
  let forwarded: Request | undefined;
  const hubFetch = vi.fn(async (request: Request) => {
    forwarded = request;
    return new Response('id: 18\nevent: github\ndata: {"sequence":18}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const env = {
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_EVENTS_FEED_TOKEN: FEED_TOKEN,
    GITHUB_REPOSITORY: "pingdotgg/t3code",
    GITHUB_EVENT_HUB: {
      getByName: () => ({ fetch: hubFetch }),
    },
  } satisfies GitHubEventsEnv;

  const response = await handleRequest(
    new Request("https://events.example/v1/repos/pingdotgg/t3code/events?pull=42", {
      headers: {
        authorization: `Bearer ${FEED_TOKEN}`,
        "last-event-id": "17",
      },
    }),
    env,
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(await response.text()).toContain("id: 18");
  if (!forwarded) throw new Error("feed was not forwarded");
  expect(new URL(forwarded.url).searchParams.get("after")).toBe("17");
  expect(new URL(forwarded.url).searchParams.get("pull")).toBe("42");
});

it("rejects oversized webhook payloads before reading them", async () => {
  const hubFetch = vi.fn(async () => new Response(null, { status: 201 }));
  const env = {
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_EVENTS_FEED_TOKEN: FEED_TOKEN,
    GITHUB_REPOSITORY: "pingdotgg/t3code",
    GITHUB_EVENT_HUB: { getByName: () => ({ fetch: hubFetch }) },
  } satisfies GitHubEventsEnv;

  const response = await handleRequest(
    new Request("https://events.example/v1/github/webhook", {
      method: "POST",
      body: "{}",
      headers: {
        "content-length": String(1024 * 1024 + 1),
        "x-github-delivery": "delivery-large",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=invalid",
      },
    }),
    env,
  );

  expect(response.status).toBe(413);
  expect(hubFetch).not.toHaveBeenCalled();
});

it("rejects webhook deliveries with invalid signatures", async () => {
  const hubFetch = vi.fn(async () => new Response(null, { status: 201 }));
  const env = {
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_EVENTS_FEED_TOKEN: FEED_TOKEN,
    GITHUB_REPOSITORY: "pingdotgg/t3code",
    GITHUB_EVENT_HUB: { getByName: () => ({ fetch: hubFetch }) },
  } satisfies GitHubEventsEnv;

  const response = await handleRequest(
    new Request("https://events.example/v1/github/webhook", {
      method: "POST",
      body: "{}",
      headers: {
        "x-github-delivery": "forged-delivery",
        "x-github-event": "pull_request",
        "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
      },
    }),
    env,
  );

  expect(response.status).toBe(401);
  expect(hubFetch).not.toHaveBeenCalled();
});

it("rejects malformed repository paths without reaching storage", async () => {
  const hubFetch = vi.fn(async () => new Response("unexpected"));
  const env = {
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_EVENTS_FEED_TOKEN: FEED_TOKEN,
    GITHUB_REPOSITORY: "pingdotgg/t3code",
    GITHUB_EVENT_HUB: { getByName: () => ({ fetch: hubFetch }) },
  } satisfies GitHubEventsEnv;

  const response = await handleRequest(
    new Request("https://events.example/v1/repos/%E0%A4%A/t3code/events", {
      headers: { authorization: `Bearer ${FEED_TOKEN}` },
    }),
    env,
  );

  expect(response.status).toBe(400);
  expect(hubFetch).not.toHaveBeenCalled();
});

it("rejects feed requests with invalid bearer tokens", async () => {
  const hubFetch = vi.fn(async () => new Response("unexpected"));
  const env = {
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_EVENTS_FEED_TOKEN: FEED_TOKEN,
    GITHUB_REPOSITORY: "pingdotgg/t3code",
    GITHUB_EVENT_HUB: { getByName: () => ({ fetch: hubFetch }) },
  } satisfies GitHubEventsEnv;

  const response = await handleRequest(
    new Request("https://events.example/v1/repos/pingdotgg/t3code/events", {
      headers: { authorization: "Bearer wrong-token" },
    }),
    env,
  );

  expect(response.status).toBe(401);
  expect(hubFetch).not.toHaveBeenCalled();
});

it("fails closed when secrets are too short", async () => {
  const env = {
    GITHUB_WEBHOOK_SECRET: "short",
    GITHUB_EVENTS_FEED_TOKEN: "short",
    GITHUB_REPOSITORY: "pingdotgg/t3code",
    GITHUB_EVENT_HUB: { getByName: () => ({ fetch: vi.fn() }) },
  } satisfies GitHubEventsEnv;

  const response = await handleRequest(new Request("https://events.example/health"), env);
  expect(response.status).toBe(503);

  const missingSecret = {
    ...env,
    GITHUB_WEBHOOK_SECRET: undefined,
  } as unknown as GitHubEventsEnv;
  const missingResponse = await handleRequest(
    new Request("https://events.example/health"),
    missingSecret,
  );
  expect(missingResponse.status).toBe(503);
});

it("returns a stable error when event storage is unavailable", async () => {
  const hubFetch = vi.fn(async () => {
    throw new Error("storage unavailable");
  });
  const env = {
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_EVENTS_FEED_TOKEN: FEED_TOKEN,
    GITHUB_REPOSITORY: "pingdotgg/t3code",
    GITHUB_EVENT_HUB: { getByName: () => ({ fetch: hubFetch }) },
  } satisfies GitHubEventsEnv;

  const response = await handleRequest(
    new Request("https://events.example/v1/repos/pingdotgg/t3code/events", {
      headers: { authorization: `Bearer ${FEED_TOKEN}` },
    }),
    env,
  );
  expect(response.status).toBe(502);

  const lookupFailureEnv = {
    ...env,
    GITHUB_EVENT_HUB: {
      getByName: () => {
        throw new Error("namespace unavailable");
      },
    },
  } satisfies GitHubEventsEnv;
  const lookupFailure = await handleRequest(
    new Request("https://events.example/v1/repos/pingdotgg/t3code/events", {
      headers: { authorization: `Bearer ${FEED_TOKEN}` },
    }),
    lookupFailureEnv,
  );
  expect(lookupFailure.status).toBe(502);
});
