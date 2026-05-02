import { httpRouter } from "convex/server";
import { Schema } from "effect";
import { TaskRuntimeLifecycleEvent } from "@t3tools/contracts";

import {
  buildLinearInstallUrl,
  buildLinearOAuthCallbackUrl,
  exchangeLinearOAuthCode,
  renderLinearOAuthPage,
} from "../src/linear/oauth.ts";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { httpAction } from "./_generated/server.js";

const http = httpRouter();
const decodeTaskRuntimeLifecycleEvent = Schema.decodeUnknownSync(TaskRuntimeLifecycleEvent);

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

http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => new Response("ok", { status: 200 })),
});

http.route({
  path: "/linear/oauth/install",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      return Response.redirect(buildLinearInstallUrl(new URL(request.url).origin), 302);
    } catch (error) {
      return renderLinearOAuthPage({
        status: "error",
        title: "Linear Install Could Not Start",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }),
});

http.route({
  path: "/linear/oauth/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const error = url.searchParams.get("error");
    if (error) {
      return renderLinearOAuthPage({
        status: "error",
        title: "Linear Install Was Cancelled",
        detail: error,
      });
    }

    const code = url.searchParams.get("code");
    if (!code) {
      return renderLinearOAuthPage({
        status: "error",
        title: "Linear Install Did Not Return A Code",
        detail: "Linear redirected back without an authorization code.",
      });
    }

    try {
      const result = await exchangeLinearOAuthCode({
        code,
        redirectUri: buildLinearOAuthCallbackUrl(url.origin),
      });

      return renderLinearOAuthPage({
        status: "success",
        title: "Linear App Install Completed",
        detail: `OAuth callback completed successfully.${result.scope ? ` Granted scopes: ${result.scope}.` : ""} You can close this tab and continue with webhook testing.`,
      });
    } catch (callbackError) {
      return renderLinearOAuthPage({
        status: "error",
        title: "Linear Install Callback Failed",
        detail: callbackError instanceof Error ? callbackError.message : String(callbackError),
      });
    }
  }),
});

http.route({
  path: "/linear/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    return forwardChatSdkWebhook(ctx, request, "linear");
  }),
});

http.route({
  path: "/slack/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    return forwardChatSdkWebhook(ctx, request, "slack");
  }),
});

http.route({
  path: "/t3/task-runtime-events",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = requireBridgeAuthorization(request);
    if (!auth.ok) {
      return Response.json({ error: auth.message }, { status: auth.status });
    }

    const payload = decodeTaskRuntimeLifecycleEvent(await request.json());
    const result = await ctx.runMutation(internal.t3Runtime.applyTaskRuntimeLifecycleEvent, {
      eventId: payload.eventId,
      taskId: payload.taskId as Id<"tasks">,
      workSessionId: payload.workSessionId as Id<"workSessions">,
      type: payload.type,
      occurredAt: payload.occurredAt,
      ...(payload.t3ThreadId !== undefined ? { t3ThreadId: String(payload.t3ThreadId) } : {}),
      ...(payload.t3TurnId !== undefined ? { t3TurnId: String(payload.t3TurnId) } : {}),
      ...(payload.failureSummary !== undefined ? { failureSummary: payload.failureSummary } : {}),
    });

    let intakeReply:
      | {
          readonly posted: boolean;
          readonly reason?: string;
          readonly externalMessageId?: string;
        }
      | undefined;
    if (payload.type === "completed" || payload.type === "failed") {
      try {
        intakeReply = await ctx.runAction(internal.taskIntake.postTaskRuntimeLifecycleReply, {
          taskId: payload.taskId as Id<"tasks">,
          workSessionId: payload.workSessionId as Id<"workSessions">,
          status: payload.type,
          occurredAt: payload.occurredAt,
          ...(payload.t3ThreadId !== undefined ? { t3ThreadId: String(payload.t3ThreadId) } : {}),
          ...(payload.failureSummary !== undefined
            ? { failureSummary: payload.failureSummary }
            : {}),
        });
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
  source: "linear" | "slack",
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
