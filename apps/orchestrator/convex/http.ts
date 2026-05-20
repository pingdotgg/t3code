import { httpRouter } from "convex/server";
import * as Schema from "effect/Schema";
import {
  TaskRuntimeAssistantMessageEvent,
  TaskRuntimeLifecycleEvent,
  TaskRuntimeUserInputRequestEvent,
} from "@t3tools/contracts";

import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { httpAction } from "./_generated/server.js";

const http = httpRouter();
const decodeTaskRuntimeAssistantMessageEvent = Schema.decodeUnknownSync(
  TaskRuntimeAssistantMessageEvent,
);
const decodeTaskRuntimeLifecycleEvent = Schema.decodeUnknownSync(TaskRuntimeLifecycleEvent);
const decodeTaskRuntimeUserInputRequestEvent = Schema.decodeUnknownSync(
  TaskRuntimeUserInputRequestEvent,
);

function requireBridgeAuthorization(request: Request) {
  const secret = process.env.T3_EXECUTION_BRIDGE_SHARED_SECRET?.trim();
  if (!secret) {
    return {
      ok: false as const,
      status: 503,
      message: "Missing orchestrator bridge secret",
    };
  }

  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${secret}`) {
    return {
      ok: false as const,
      status: 401,
      message: "Unauthorized execution bridge callback",
    };
  }

  return { ok: true as const };
}

function requireOpsAlertAuthorization(request: Request) {
  const secret = process.env.T3_OPS_ALERT_SECRET?.trim();
  if (!secret) {
    return {
      ok: false as const,
      status: 503,
      message: "Missing ops alert secret",
    };
  }

  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${secret}`) {
    return {
      ok: false as const,
      status: 401,
      message: "Unauthorized ops alert request",
    };
  }

  return { ok: true as const };
}

function errorSummary(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function logHttpEvent(
  ctx: Parameters<Parameters<typeof httpAction>[0]>[0],
  input: {
    readonly kind: string;
    readonly source: string;
    readonly severity?: "debug" | "info" | "warn" | "error" | undefined;
    readonly summary: string;
    readonly eventKey?: string | undefined;
    readonly taskId?: Id<"tasks"> | undefined;
    readonly workSessionId?: Id<"workSessions"> | undefined;
    readonly externalId?: string | undefined;
    readonly payload?: unknown | undefined;
  },
) {
  const payloadJson = input.payload === undefined ? undefined : JSON.stringify(input.payload);
  console[input.severity === "error" ? "error" : input.severity === "warn" ? "warn" : "log"](
    input.kind,
    {
      source: input.source,
      summary: input.summary,
      ...(input.eventKey !== undefined ? { eventKey: input.eventKey } : {}),
      ...(input.taskId !== undefined ? { taskId: String(input.taskId) } : {}),
      ...(input.workSessionId !== undefined ? { workSessionId: String(input.workSessionId) } : {}),
      ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    },
  );
  return ctx
    .runMutation(internal.observability.append, {
      kind: input.kind,
      source: input.source,
      severity: input.severity ?? "info",
      summary: input.summary,
      ...(input.eventKey !== undefined ? { eventKey: input.eventKey } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.workSessionId !== undefined ? { workSessionId: input.workSessionId } : {}),
      ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
      ...(payloadJson !== undefined ? { payloadJson } : {}),
    })
    .catch((error) => {
      console.warn("observability.append.failed", {
        kind: input.kind,
        error: errorSummary(error),
      });
    });
}

function timingSafeEqualString(actual: string, expected: string) {
  if (actual.length !== expected.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < actual.length; index += 1) {
    diff |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

function objectField(input: object, field: string) {
  return (input as Record<string, unknown>)[field];
}

async function verifyGitHubWebhookSignature(body: string, signature: string | null) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return {
      ok: false as const,
      status: 503,
      message: "Missing GitHub webhook secret",
    };
  }
  if (signature === null || !signature.startsWith("sha256=")) {
    return {
      ok: false as const,
      status: 401,
      message: "Missing GitHub webhook signature",
    };
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = `sha256=${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;

  if (!timingSafeEqualString(signature, expected)) {
    return {
      ok: false as const,
      status: 401,
      message: "Invalid GitHub webhook signature",
    };
  }

  return { ok: true as const };
}

http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => new Response("ok", { status: 200 })),
});

http.route({
  path: "/slack/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    await logHttpEvent(ctx, {
      kind: "http.slack-webhook.received",
      source: "slack",
      summary: "Received Slack Chat SDK webhook.",
      payload: {
        contentLength: request.headers.get("content-length"),
      },
    });
    return forwardChatSdkWebhook(ctx, request, "slack");
  }),
});

http.route({
  path: "/github/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.text();
    const event = request.headers.get("x-github-event") ?? "";
    const deliveryId = request.headers.get("x-github-delivery") ?? "";
    await logHttpEvent(ctx, {
      kind: "http.github-webhook.received",
      source: "github",
      summary: "Received GitHub webhook.",
      eventKey: deliveryId ? `github:${deliveryId}:received` : undefined,
      externalId: deliveryId || undefined,
      payload: {
        event,
        deliveryId,
        bodyBytes: body.length,
      },
    });
    const auth = await verifyGitHubWebhookSignature(
      body,
      request.headers.get("x-hub-signature-256"),
    );
    if (!auth.ok) {
      await logHttpEvent(ctx, {
        kind: "http.github-webhook.auth-failed",
        source: "github",
        severity: auth.status >= 500 ? "error" : "warn",
        summary: auth.message,
        eventKey: deliveryId ? `github:${deliveryId}:auth-failed` : undefined,
        externalId: deliveryId || undefined,
        payload: {
          event,
          deliveryId,
          status: auth.status,
        },
      });
      return Response.json({ error: auth.message }, { status: auth.status });
    }

    const result = await ctx.runAction(internal.github.handleWebhook, {
      event,
      deliveryId,
      body,
    });
    await logHttpEvent(ctx, {
      kind: "http.github-webhook.handled",
      source: "github",
      summary: "GitHub webhook action completed.",
      eventKey: deliveryId ? `github:${deliveryId}:handled` : undefined,
      externalId: deliveryId || undefined,
      payload: {
        event,
        deliveryId,
        ...result,
      },
    });

    return Response.json({
      accepted: true,
      ...result,
    });
  }),
});

http.route({
  path: "/support-email/resend",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.text();
    await logHttpEvent(ctx, {
      kind: "http.support-email.resend-received",
      source: "support_email",
      summary: "Received Resend support email webhook.",
      payload: {
        contentLength: request.headers.get("content-length"),
        svixId: request.headers.get("svix-id"),
      },
    });
    try {
      const result = await ctx.runAction(internal.supportEmail.handleResendWebhook, {
        headers: Array.from(request.headers.entries()).map(([name, value]) => ({ name, value })),
        body,
      });
      await logHttpEvent(ctx, {
        kind: "http.support-email.resend-handled",
        source: "support_email",
        summary: "Handled Resend support email webhook.",
        payload: result,
      });
      return Response.json(result);
    } catch (error) {
      await logHttpEvent(ctx, {
        kind: "http.support-email.resend-failed",
        source: "support_email",
        severity: "error",
        summary: "Failed to handle Resend support email webhook.",
        payload: {
          error: errorSummary(error),
        },
      });
      return Response.json({ error: errorSummary(error) }, { status: 400 });
    }
  }),
});

http.route({
  path: "/ops/health-alert",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = requireOpsAlertAuthorization(request);
    if (!auth.ok) {
      await logHttpEvent(ctx, {
        kind: "http.ops-health-alert.auth-failed",
        source: "ops",
        severity: auth.status >= 500 ? "error" : "warn",
        summary: auth.message,
        payload: {
          status: auth.status,
        },
      });
      return Response.json({ error: auth.message }, { status: auth.status });
    }

    type OpsHealthAlertPayload = {
      readonly checkedAt?: unknown;
      readonly status?: unknown;
      readonly results?: unknown;
      readonly summary?: unknown;
    };
    let body: OpsHealthAlertPayload;
    try {
      body = (await request.json()) as OpsHealthAlertPayload;
    } catch (error) {
      await logHttpEvent(ctx, {
        kind: "http.ops-health-alert.invalid-json",
        source: "ops",
        severity: "warn",
        summary: "Invalid ops health alert JSON.",
        payload: {
          error: errorSummary(error),
        },
      });
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (
      typeof body.checkedAt !== "string" ||
      (body.status !== "failing" && body.status !== "recovered") ||
      !Array.isArray(body.results)
    ) {
      await logHttpEvent(ctx, {
        kind: "http.ops-health-alert.invalid-payload",
        source: "ops",
        severity: "warn",
        summary: "Invalid ops health alert payload.",
      });
      return Response.json({ error: "Invalid ops health alert payload" }, { status: 400 });
    }

    const results = body.results.flatMap((result) => {
      if (
        result === null ||
        typeof result !== "object" ||
        typeof objectField(result, "name") !== "string" ||
        typeof objectField(result, "ok") !== "boolean" ||
        typeof objectField(result, "details") !== "string"
      ) {
        return [];
      }
      return [
        {
          name: objectField(result, "name") as string,
          ok: objectField(result, "ok") as boolean,
          details: objectField(result, "details") as string,
        },
      ];
    });
    if (results.length !== body.results.length) {
      return Response.json({ error: "Invalid ops health check result" }, { status: 400 });
    }

    await logHttpEvent(ctx, {
      kind: "http.ops-health-alert.received",
      source: "ops",
      severity: body.status === "failing" ? "warn" : "info",
      summary: "Received ops health alert.",
      payload: {
        status: body.status,
        checkedAt: body.checkedAt,
        resultCount: results.length,
        failingCount: results.filter((result) => !result.ok).length,
      },
    });

    const posted = await ctx.runAction(internal.ops.postHealthAlert, {
      checkedAt: body.checkedAt,
      status: body.status,
      results,
      ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
    });
    return Response.json(posted, { status: posted.posted ? 200 : 502 });
  }),
});

http.route({
  path: "/t3/task-runtime-assistant-messages",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = requireBridgeAuthorization(request);
    if (!auth.ok) {
      await logHttpEvent(ctx, {
        kind: "http.t3-assistant-message.auth-failed",
        source: "t3",
        severity: auth.status >= 500 ? "error" : "warn",
        summary: auth.message,
        payload: { status: auth.status },
      });
      return Response.json({ error: auth.message }, { status: auth.status });
    }

    const payload = decodeTaskRuntimeAssistantMessageEvent(await request.json());
    await logHttpEvent(ctx, {
      kind: "http.t3-assistant-message.received",
      source: "t3",
      summary: "Received T3 assistant message callback.",
      eventKey: `${String(payload.eventId)}:http-received`,
      taskId: payload.taskId as Id<"tasks">,
      workSessionId: payload.workSessionId as Id<"workSessions">,
      payload: {
        eventId: payload.eventId,
        t3ThreadId: String(payload.t3ThreadId),
        t3MessageId: String(payload.t3MessageId),
        t3TurnId: payload.t3TurnId === undefined ? undefined : String(payload.t3TurnId),
      },
    });
    await ctx.runMutation(internal.t3Runtime.recordTaskPullRequestsFromAssistantMessage, {
      taskId: payload.taskId as Id<"tasks">,
      workSessionId: payload.workSessionId as Id<"workSessions">,
      sourceEventId: payload.eventId,
      assistantMessage: payload.assistantMessage,
      observedAt: Date.now(),
    });
    const result = await ctx.runAction(internal.taskIntake.postTaskRuntimeAssistantMessage, {
      eventId: payload.eventId,
      taskId: payload.taskId as Id<"tasks">,
      workSessionId: payload.workSessionId as Id<"workSessions">,
      occurredAt: payload.occurredAt,
      t3ThreadId: String(payload.t3ThreadId),
      t3MessageId: String(payload.t3MessageId),
      ...(payload.t3TurnId !== undefined ? { t3TurnId: String(payload.t3TurnId) } : {}),
      assistantMessage: payload.assistantMessage,
    });

    return Response.json({
      accepted: true,
      ...result,
    });
  }),
});

http.route({
  path: "/t3/task-runtime-user-input-requests",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = requireBridgeAuthorization(request);
    if (!auth.ok) {
      await logHttpEvent(ctx, {
        kind: "http.t3-user-input-request.auth-failed",
        source: "t3",
        severity: auth.status >= 500 ? "error" : "warn",
        summary: auth.message,
        payload: { status: auth.status },
      });
      return Response.json({ error: auth.message }, { status: auth.status });
    }

    const payload = decodeTaskRuntimeUserInputRequestEvent(await request.json());
    await logHttpEvent(ctx, {
      kind: "http.t3-user-input-request.received",
      source: "t3",
      summary: "Received T3 user-input request callback.",
      eventKey: `${String(payload.eventId)}:http-received`,
      taskId: payload.taskId as Id<"tasks">,
      workSessionId: payload.workSessionId as Id<"workSessions">,
      payload: {
        eventId: payload.eventId,
        t3ThreadId: String(payload.t3ThreadId),
        t3TurnId: payload.t3TurnId === undefined ? undefined : String(payload.t3TurnId),
        requestId: String(payload.requestId),
        questionCount: payload.questions.length,
      },
    });
    const result = await ctx.runAction(internal.taskIntake.postTaskRuntimeUserInputRequest, {
      eventId: payload.eventId,
      taskId: payload.taskId as Id<"tasks">,
      workSessionId: payload.workSessionId as Id<"workSessions">,
      occurredAt: payload.occurredAt,
      t3ThreadId: String(payload.t3ThreadId),
      ...(payload.t3TurnId !== undefined ? { t3TurnId: String(payload.t3TurnId) } : {}),
      requestId: String(payload.requestId),
      questionsJson: JSON.stringify(payload.questions),
    });

    return Response.json({
      accepted: true,
      ...result,
    });
  }),
});

http.route({
  path: "/t3/task-runtime-events",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = requireBridgeAuthorization(request);
    if (!auth.ok) {
      await logHttpEvent(ctx, {
        kind: "http.t3-runtime-event.auth-failed",
        source: "t3",
        severity: auth.status >= 500 ? "error" : "warn",
        summary: auth.message,
        payload: { status: auth.status },
      });
      return Response.json({ error: auth.message }, { status: auth.status });
    }

    const payload = decodeTaskRuntimeLifecycleEvent(await request.json());
    await logHttpEvent(ctx, {
      kind: "http.t3-runtime-event.received",
      source: "t3",
      summary: "Received T3 runtime lifecycle callback.",
      eventKey: `${String(payload.eventId)}:http-received`,
      taskId: payload.taskId as Id<"tasks">,
      workSessionId: payload.workSessionId as Id<"workSessions">,
      payload: {
        eventId: payload.eventId,
        type: payload.type,
        t3ThreadId: payload.t3ThreadId === undefined ? undefined : String(payload.t3ThreadId),
        t3TurnId: payload.t3TurnId === undefined ? undefined : String(payload.t3TurnId),
      },
    });
    const result = await ctx.runMutation(internal.t3Runtime.applyTaskRuntimeLifecycleEvent, {
      eventId: payload.eventId,
      taskId: payload.taskId as Id<"tasks">,
      workSessionId: payload.workSessionId as Id<"workSessions">,
      type: payload.type,
      occurredAt: payload.occurredAt,
      ...(payload.t3ThreadId !== undefined ? { t3ThreadId: String(payload.t3ThreadId) } : {}),
      ...(payload.t3TurnId !== undefined ? { t3TurnId: String(payload.t3TurnId) } : {}),
      ...(payload.failureSummary !== undefined ? { failureSummary: payload.failureSummary } : {}),
      ...(payload.assistantResponse !== undefined
        ? { assistantResponse: payload.assistantResponse }
        : {}),
    });
    if (payload.assistantResponse !== undefined) {
      await ctx.runMutation(internal.t3Runtime.recordTaskPullRequestsFromAssistantMessage, {
        taskId: payload.taskId as Id<"tasks">,
        workSessionId: payload.workSessionId as Id<"workSessions">,
        sourceEventId: payload.eventId,
        assistantMessage: payload.assistantResponse,
        observedAt: Date.now(),
      });
    }

    let intakeReply:
      | {
          readonly posted: boolean;
          readonly reason?: string;
          readonly externalMessageId?: string;
        }
      | undefined;
    if (payload.type === "completed" || payload.type === "failed") {
      try {
        if (payload.type === "completed" && payload.assistantResponse !== undefined) {
          try {
            intakeReply = await ctx.runAction(internal.taskIntake.postTaskRuntimeLifecycleReply, {
              taskId: payload.taskId as Id<"tasks">,
              workSessionId: payload.workSessionId as Id<"workSessions">,
              status: payload.type,
              occurredAt: payload.occurredAt,
              ...(payload.t3ThreadId !== undefined
                ? { t3ThreadId: String(payload.t3ThreadId) }
                : {}),
              ...(payload.t3TurnId !== undefined ? { t3TurnId: String(payload.t3TurnId) } : {}),
              assistantResponse: payload.assistantResponse,
            });
          } catch (error) {
            intakeReply = {
              posted: false,
              reason: error instanceof Error ? error.message : String(error),
            };
          }
        }

        if (payload.type === "failed") {
          intakeReply = await ctx.runAction(internal.taskIntake.postTaskRuntimeLifecycleReply, {
            taskId: payload.taskId as Id<"tasks">,
            workSessionId: payload.workSessionId as Id<"workSessions">,
            status: payload.type,
            occurredAt: payload.occurredAt,
            ...(payload.t3ThreadId !== undefined ? { t3ThreadId: String(payload.t3ThreadId) } : {}),
            ...(payload.t3TurnId !== undefined ? { t3TurnId: String(payload.t3TurnId) } : {}),
            ...(payload.failureSummary !== undefined
              ? { failureSummary: payload.failureSummary }
              : {}),
            ...(payload.assistantResponse !== undefined
              ? { assistantResponse: payload.assistantResponse }
              : {}),
          });
        }
      } catch (error) {
        intakeReply = {
          posted: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return Response.json({
      accepted: true,
      ...result,
      ...(intakeReply !== undefined ? { intakeReply } : {}),
    });
  }),
});

export default http;

async function forwardChatSdkWebhook(
  ctx: Parameters<Parameters<typeof httpAction>[0]>[0],
  request: Request,
  source: "slack",
) {
  const result = await ctx.runAction(internal.taskIntake.handleChatSdkWebhook, {
    source,
    url: request.url,
    headers: Array.from(request.headers.entries()).map(([name, value]) => ({ name, value })),
    body: await request.text(),
  });

  const init =
    result.contentType === undefined
      ? { status: result.status }
      : { status: result.status, headers: { "content-type": result.contentType } };

  return new Response(result.body, {
    ...init,
  });
}
