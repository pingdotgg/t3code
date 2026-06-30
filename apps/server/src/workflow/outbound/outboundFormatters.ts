/**
 * Pure outbound payload formatters.
 *
 * Turns a normalized OutboundEventContext into an HTTP body ready for the
 * outbound dispatcher to POST.  No IO — purely deterministic string
 * construction.
 *
 * Link-agnostic by design: the formatter NEVER builds a route. The dispatcher
 * (Task 12) owns base-URL config + the runtime environmentId, so it constructs
 * the absolute ticket URL and passes it in via RenderOptions.ticketUrl. This
 * matters for Slack: a Block Kit button `url` MUST be an absolute http(s) URL —
 * a relative path makes Slack reject the entire message (HTTP 400
 * invalid_blocks). When no absolute URL is available, the Slack actions block is
 * omitted entirely (a still-valid, deliverable message), and the generic
 * envelope's ticket.url is null.
 */

import type { OutboundEventContext, OutboundFormatter } from "@t3tools/contracts";

export interface RenderedDelivery {
  readonly body: string;
  readonly contentType: string;
}

export interface RenderOptions {
  readonly connection: { readonly kind: string; readonly url: string };
  readonly ticketUrl?: string; // a fully-formed ABSOLUTE url, or undefined if none available
}

const TRIGGER_LABEL: Record<string, string> = {
  needs_attention: "Needs attention",
  blocked: "Blocked",
  done: "Done",
  lane_entered: "Moved",
};

const generic = (ctx: OutboundEventContext, ticketUrl: string | undefined): RenderedDelivery => ({
  contentType: "application/json",
  body: JSON.stringify({
    event: ctx.trigger,
    board: { id: ctx.boardId },
    ticket: {
      id: ctx.ticketId,
      title: ctx.title,
      status: ctx.status,
      lane: ctx.toLane,
      url: ticketUrl ?? null,
    },
    occurredAt: ctx.occurredAt,
    context: ctx,
  }),
});

const slack = (ctx: OutboundEventContext, ticketUrl: string | undefined): RenderedDelivery => {
  const header = TRIGGER_LABEL[ctx.trigger] ?? ctx.trigger;
  const fallback = `${header}: ${ctx.title} (${ctx.status})`;
  const sectionText = [
    `*${ctx.title}*`,
    `Status: ${ctx.status}`,
    ctx.toLane ? `Lane: ${ctx.toLane}` : null,
    ctx.reason ? `Reason: ${ctx.reason}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const blocks: Array<Record<string, unknown>> = [
    { type: "header", text: { type: "plain_text", text: header } },
    { type: "section", text: { type: "mrkdwn", text: sectionText } },
  ];

  // Slack rejects a button with a relative/empty url (HTTP 400 invalid_blocks),
  // so only attach the "View ticket" action when we have an absolute URL.
  if (ticketUrl !== undefined) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View ticket" },
          url: ticketUrl,
        },
      ],
    });
  }

  return {
    contentType: "application/json",
    body: JSON.stringify({ text: fallback, blocks }),
  };
};

export const renderOutbound = (
  formatter: OutboundFormatter,
  ctx: OutboundEventContext,
  options: RenderOptions,
): RenderedDelivery =>
  formatter === "slack" ? slack(ctx, options.ticketUrl) : generic(ctx, options.ticketUrl);
