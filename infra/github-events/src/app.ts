// @effect-diagnostics globalDate:off - The native Worker records webhook receipt time outside an Effect runtime.
import { normalizeWebhook } from "./events.ts";
import { verifyGitHubSignature } from "./signature.ts";

const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;
const MAX_WEBHOOK_READ_MS = 10_000;
const MIN_SECRET_LENGTH = 32;

interface EventHubStub {
  fetch(request: Request): Promise<Response>;
}

interface EventHubNamespace {
  getByName(name: string): EventHubStub;
}

export interface GitHubEventsEnv {
  readonly GITHUB_WEBHOOK_SECRET: string;
  readonly GITHUB_EVENTS_FEED_TOKEN: string;
  readonly GITHUB_REPOSITORY: string;
  readonly GITHUB_EVENT_HUB: EventHubNamespace;
}

function configurationIsValid(env: GitHubEventsEnv): boolean {
  return (
    typeof env.GITHUB_WEBHOOK_SECRET === "string" &&
    env.GITHUB_WEBHOOK_SECRET.trim().length >= MIN_SECRET_LENGTH &&
    typeof env.GITHUB_EVENTS_FEED_TOKEN === "string" &&
    env.GITHUB_EVENTS_FEED_TOKEN.trim().length >= MIN_SECRET_LENGTH &&
    typeof env.GITHUB_REPOSITORY === "string" &&
    /^[^/\s]+\/[^/\s]+$/.test(env.GITHUB_REPOSITORY) &&
    typeof env.GITHUB_EVENT_HUB?.getByName === "function"
  );
}

function jsonResponse(value: unknown, status: number): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function parseNonNegativeInteger(value: string | null): number | undefined | null {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readLimitedBody(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limit) return null;
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const body = new Uint8Array(limit);
  const timeoutSignal = AbortSignal.timeout(MAX_WEBHOOK_READ_MS);
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutSignal.addEventListener(
      "abort",
      () => reject(new Error("webhook body read timed out")),
      { once: true },
    );
  });
  let length = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      if (length + value.byteLength > limit) {
        await reader.cancel();
        return null;
      }
      body.set(value, length);
      length += value.byteLength;
    }
  } catch (error) {
    await reader.cancel(error);
    throw error;
  }
  return body.subarray(0, length);
}

async function handleWebhook(request: Request, env: GitHubEventsEnv): Promise<Response> {
  const deliveryId = request.headers.get("x-github-delivery");
  const eventName = request.headers.get("x-github-event");
  const signature = request.headers.get("x-hub-signature-256");
  if (!deliveryId || !eventName || !signature) {
    return jsonResponse({ error: "missing github webhook headers" }, 400);
  }

  let body: Uint8Array<ArrayBuffer> | null;
  try {
    body = await readLimitedBody(request, MAX_WEBHOOK_BODY_BYTES);
  } catch {
    return jsonResponse({ error: "webhook body could not be read" }, 400);
  }
  if (!body) return jsonResponse({ error: "webhook payload is too large" }, 413);
  try {
    if (!(await verifyGitHubSignature(body, signature, env.GITHUB_WEBHOOK_SECRET))) {
      return jsonResponse({ error: "invalid webhook signature" }, 401);
    }
  } catch {
    return jsonResponse({ error: "webhook signature could not be verified" }, 503);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return jsonResponse({ error: "invalid json payload" }, 400);
  }

  const event = normalizeWebhook({
    deliveryId,
    eventName,
    payload,
    receivedAt: new Date().toISOString(),
  });
  if (!event) return jsonResponse({ accepted: false, ignored: true }, 202);
  if (event.repository.fullName.toLowerCase() !== env.GITHUB_REPOSITORY.toLowerCase()) {
    return jsonResponse({ error: "repository is not allowed" }, 403);
  }

  let stored: Response;
  try {
    const hub = env.GITHUB_EVENT_HUB.getByName(event.repository.fullName.toLowerCase());
    stored = await hub.fetch(
      new Request("https://github-event-hub.internal/events", {
        method: "POST",
        body: JSON.stringify(event),
        headers: { "content-type": "application/json" },
      }),
    );
  } catch {
    return jsonResponse({ error: "event persistence failed" }, 502);
  }
  if (!stored.ok) return jsonResponse({ error: "event persistence failed" }, 502);
  return jsonResponse({ accepted: true }, 202);
}

async function handleFeed(request: Request, env: GitHubEventsEnv, url: URL): Promise<Response> {
  const match = /^\/v1\/repos\/([^/]+)\/([^/]+)\/events$/.exec(url.pathname);
  if (!match) return jsonResponse({ error: "not found" }, 404);

  let repository: string;
  try {
    repository = `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`;
  } catch {
    return jsonResponse({ error: "invalid repository path" }, 400);
  }
  if (repository.toLowerCase() !== env.GITHUB_REPOSITORY.toLowerCase()) {
    return jsonResponse({ error: "repository is not allowed" }, 404);
  }

  const authorization = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.GITHUB_EVENTS_FEED_TOKEN}`;
  if (!constantTimeEqual(authorization, expected)) {
    return jsonResponse({ error: "invalid feed token" }, 401);
  }

  const after = parseNonNegativeInteger(
    url.searchParams.get("after") ?? request.headers.get("last-event-id"),
  );
  const pull = parseNonNegativeInteger(url.searchParams.get("pull"));
  if (after === null || pull === null || pull === 0) {
    return jsonResponse({ error: "invalid feed cursor or pull request number" }, 400);
  }

  const hubUrl = new URL("https://github-event-hub.internal/events");
  if (after !== undefined) hubUrl.searchParams.set("after", String(after));
  if (pull !== undefined) hubUrl.searchParams.set("pull", String(pull));
  try {
    const hub = env.GITHUB_EVENT_HUB.getByName(repository.toLowerCase());
    return await hub.fetch(new Request(hubUrl, { signal: request.signal }));
  } catch {
    return jsonResponse({ error: "event feed is unavailable" }, 502);
  }
}

export async function handleRequest(request: Request, env: GitHubEventsEnv): Promise<Response> {
  if (!configurationIsValid(env)) {
    return jsonResponse({ error: "service configuration is invalid" }, 503);
  }
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ ok: true }, 200);
  }
  if (request.method === "POST" && url.pathname === "/v1/github/webhook") {
    return handleWebhook(request, env);
  }
  if (request.method === "GET" && url.pathname.startsWith("/v1/repos/")) {
    return handleFeed(request, env, url);
  }
  return jsonResponse({ error: "not found" }, 404);
}
