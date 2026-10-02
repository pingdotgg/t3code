/**
 * Thread title generation on OpenCode 2's free tier, recorded live against
 * 2.0.18 with `opencode/big-pickle` on 2026-09-30: an ask-all temporary
 * session, one prompt, the reply read from the event stream, the session
 * removed. (A deny-all session is refused on the free tier: the spike's
 * `text_generation` recording.)
 */
import type { ProviderReplayEntry } from "@t3tools/contracts";

export const OPENCODE2_TITLE_GENERATION: ReadonlyArray<ProviderReplayEntry> = [
  { type: "expect_outbound", label: "event.subscribe", frame: { type: "event.subscribe" } },
  {
    type: "emit_inbound",
    label: "server.connected",
    frame: {
      type: "sdk.event",
      event: { id: "evt_0f137a1d2001lU10ZRa5EiLHAw", type: "server.connected", data: {} },
    },
  },
  {
    type: "expect_outbound",
    label: "session.create",
    frame: {
      type: "session.create",
      input: {
        title: "T3 Code generateThreadTitle",
        location: { directory: "<any>" },
        model: { providerID: "opencode", id: "big-pickle" },
        permissions: [{ action: "*", resource: "*", effect: "ask" }],
      },
    },
  },
  {
    type: "emit_inbound",
    label: "session.create.response",
    frame: {
      type: "sdk.response",
      operation: "session.create",
      data: {
        data: {
          id: "ses_f0ec85cf6ffebfalpvV2E9nocu",
          projectID: "global",
          model: { id: "big-pickle", providerID: "opencode", variant: "default" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1790753350431, updated: 1790753350431 },
          title: "T3 Code generateThreadTitle",
          permissions: [{ action: "*", resource: "*", effect: "ask" }],
          location: { directory: "<work>" },
        },
      },
    },
  },
  {
    type: "emit_inbound",
    label: "session.created",
    frame: {
      type: "sdk.event",
      event: {
        id: "evt_0f137a31f001y6hIo9JFrLXhBa",
        created: 1790753350431,
        type: "session.created",
        location: { directory: "<work>" },
        data: {
          sessionID: "ses_f0ec85cf6ffebfalpvV2E9nocu",
          slug: "quiet-lagoon",
          version: "2.0.18",
          projectID: "global",
          location: { directory: "<work>" },
          subpath: "",
          title: "T3 Code generateThreadTitle",
          permissions: [{ action: "*", resource: "*", effect: "ask" }],
          model: { id: "big-pickle", providerID: "opencode" },
        },
        durable: { aggregateID: "ses_f0ec85cf6ffebfalpvV2E9nocu", seq: 0, version: 1 },
      },
    },
  },
  {
    type: "emit_inbound",
    label: "project.updated",
    frame: {
      type: "sdk.event",
      event: {
        id: "evt_0f137a32a001SNTdr1fGy7x8KA",
        created: 1790753350442,
        type: "project.updated",
        data: {
          id: "global",
          canonical: "<work>",
          vcs: "git",
          time: { created: 1790744321645, updated: 1790744321645, active: 1790753350441 },
          sandboxes: [],
        },
      },
    },
  },
  {
    type: "expect_outbound",
    label: "session.prompt",
    frame: {
      type: "session.prompt",
      input: { sessionID: "ses_f0ec85cf6ffebfalpvV2E9nocu", text: "<any>" },
    },
  },
  {
    type: "emit_inbound",
    label: "session.prompt.response",
    frame: {
      type: "sdk.response",
      operation: "session.prompt",
      data: {
        data: {
          id: "msg_0f137a333001NQCSi7im6QbeRu",
          sessionID: "ses_f0ec85cf6ffebfalpvV2E9nocu",
          time: { created: 1790753350454 },
          type: "user",
          payload: {
            text: 'You write concise thread titles for coding conversations. Return only a JSON object with key "title". Title: at most 5 words, no quotes. User message: "fix the login redirect loop after oauth"',
          },
          delivery: "steer",
        },
      },
    },
  },
  {
    type: "emit_inbound",
    label: "session.inbox.enqueued",
    frame: {
      type: "sdk.event",
      event: {
        id: "evt_0f137a336001aSMpzX88Wc2ggd",
        created: 1790753350454,
        type: "session.inbox.enqueued",
        location: { directory: "<work>" },
        data: {
          inboxID: "msg_0f137a333001NQCSi7im6QbeRu",
          sessionID: "ses_f0ec85cf6ffebfalpvV2E9nocu",
          item: {
            type: "user",
            payload: {
              text: 'You write concise thread titles for coding conversations. Return only a JSON object with key "title". Title: at most 5 words, no quotes. User message: "fix the login redirect loop after oauth"',
            },
            delivery: "steer",
          },
        },
        durable: { aggregateID: "ses_f0ec85cf6ffebfalpvV2E9nocu", seq: 1, version: 1 },
      },
    },
  },
  {
    type: "emit_inbound",
    label: "session.execution.started",
    frame: {
      type: "sdk.event",
      event: {
        id: "evt_0f137a33b001LaQlIPhw6OXE4K",
        created: 1790753350459,
        type: "session.execution.started",
        data: { sessionID: "ses_f0ec85cf6ffebfalpvV2E9nocu" },
        durable: { aggregateID: "ses_f0ec85cf6ffebfalpvV2E9nocu", seq: 2, version: 1 },
      },
    },
  },
  {
    type: "emit_inbound",
    label: "session.instructions.updated",
    frame: {
      type: "sdk.event",
      event: {
        id: "evt_0f137a355001zRM26oGzBOQK1I",
        created: 1790753350485,
        metadata: { instructions: { initial: true } },
        type: "session.instructions.updated",
        location: { directory: "<work>" },
        data: {
          sessionID: "ses_f0ec85cf6ffebfalpvV2E9nocu",
          delta: {
            "core/environment": "00e638e6e54c2bb7786ab0bade9b0f8fcb6401b64ef49fc25025dc97dc2d61ac",
            "core/date": "5a13dc24ad554b3e0bf9583fa4a5c52e130b32720d0a9562fd0e9b0ab14210a9",
            "core/codemode": "616a7ad8b8e40e8a71eab238dfbbe9eaf0f4a9e6fdad853226d075bfe602e1e6",
            "core/skill-guidance":
              "b2aff856e4c0afa54b6d56ecdc438d66a6333b36a3b62677bb1a96da62079118",
          },
        },
        durable: { aggregateID: "ses_f0ec85cf6ffebfalpvV2E9nocu", seq: 3, version: 2 },
      },
    },
  },
  {
    type: "emit_inbound",
    label: "session.inbox.delivered",
    frame: {
      type: "sdk.event",
      event: {
        id: "evt_0f137a358001Nb4SR6NyY00Zo5",
        created: 1790753350489,
        type: "session.inbox.delivered",
        location: { directory: "<work>" },
        data: {
          sessionID: "ses_f0ec85cf6ffebfalpvV2E9nocu",
          inboxID: "msg_0f137a333001NQCSi7im6QbeRu",
        },
        durable: { aggregateID: "ses_f0ec85cf6ffebfalpvV2E9nocu", seq: 4, version: 1 },
      },
    },
  },
  {
    type: "emit_inbound",
    label: "session.step.started",
    frame: {
      type: "sdk.event",
      event: {
        id: "evt_0f137a9a1001mdhCnni47bUQ1S",
        created: 1790753352097,
        type: "session.step.started",
        location: { directory: "<work>" },
        data: {
          sessionID: "ses_f0ec85cf6ffebfalpvV2E9nocu",
          agent: "build",
          model: { id: "big-pickle", providerID: "opencode", variant: "default" },
          assistantMessageID: "msg_0f137a376001CNO3tIF0OHqFsx",
          snapshot: "5ecf8511987b833d27b391b832f802775c5ca199",
          started: 1790753350567,
        },
        durable: { aggregateID: "ses_f0ec85cf6ffebfalpvV2E9nocu", seq: 5, version: 1 },
      },
    },
  },
  {
    type: "emit_inbound",
    label: "session.text.started",
    frame: {
      type: "sdk.event",
      event: {
        id: "evt_0f137a9a5001wyccz82SmtjxpF",
        created: 1790753352101,
        type: "session.text.started",
        location: { directory: "<work>" },
        data: {
          sessionID: "ses_f0ec85cf6ffebfalpvV2E9nocu",
          assistantMessageID: "msg_0f137a376001CNO3tIF0OHqFsx",
          ordinal: 0,
        },
        durable: { aggregateID: "ses_f0ec85cf6ffebfalpvV2E9nocu", seq: 6, version: 1 },
      },
    },
  },
  {
    type: "emit_inbound",
    label: "session.text.delta",
    frame: {
      type: "sdk.event",
      event: {
        id: "evt_0f137a9b5001pgNezPn61VhcVj",
        created: 1790753352117,
        type: "session.text.delta",
        location: { directory: "<work>" },
        data: {
          sessionID: "ses_f0ec85cf6ffebfalpvV2E9nocu",
          assistantMessageID: "msg_0f137a376001CNO3tIF0OHqFsx",
          ordinal: 0,
          delta: '{"title": "Fix OAuth Login Redirect Loop"}',
        },
      },
    },
  },
  {
    type: "emit_inbound",
    label: "session.text.ended",
    frame: {
      type: "sdk.event",
      event: {
        id: "evt_0f137a9b6001W0DZEOeIf3qavZ",
        created: 1790753352118,
        type: "session.text.ended",
        location: { directory: "<work>" },
        data: {
          sessionID: "ses_f0ec85cf6ffebfalpvV2E9nocu",
          assistantMessageID: "msg_0f137a376001CNO3tIF0OHqFsx",
          ordinal: 0,
          text: '{"title": "Fix OAuth Login Redirect Loop"}',
        },
        durable: { aggregateID: "ses_f0ec85cf6ffebfalpvV2E9nocu", seq: 7, version: 1 },
      },
    },
  },
  {
    type: "emit_inbound",
    label: "session.step.streamed",
    frame: {
      type: "sdk.event",
      event: {
        id: "evt_0f137a9ba0012p1Dt72Qx5gAbw",
        created: 1790753352122,
        type: "session.step.streamed",
        location: { directory: "<work>" },
        data: {
          sessionID: "ses_f0ec85cf6ffebfalpvV2E9nocu",
          assistantMessageID: "msg_0f137a376001CNO3tIF0OHqFsx",
        },
        durable: { aggregateID: "ses_f0ec85cf6ffebfalpvV2E9nocu", seq: 8, version: 1 },
      },
    },
  },
  {
    type: "emit_inbound",
    label: "session.step.ended",
    frame: {
      type: "sdk.event",
      event: {
        id: "evt_0f137a9c8001CVVUaPgaXOAnJ3",
        created: 1790753352136,
        type: "session.step.ended",
        location: { directory: "<work>" },
        data: {
          sessionID: "ses_f0ec85cf6ffebfalpvV2E9nocu",
          assistantMessageID: "msg_0f137a376001CNO3tIF0OHqFsx",
          finish: "stop",
          rawFinish: "stop",
          cost: 0,
          tokens: { input: 8927, output: 11, reasoning: 0, cache: { read: 487, write: 0 } },
          snapshot: "5ecf8511987b833d27b391b832f802775c5ca199",
          files: [],
        },
        durable: { aggregateID: "ses_f0ec85cf6ffebfalpvV2E9nocu", seq: 9, version: 1 },
      },
    },
  },
  {
    type: "emit_inbound",
    label: "session.usage.updated",
    frame: {
      type: "sdk.event",
      event: {
        id: "evt_0f137a9cd001vwSgA3M8W9SR9P",
        created: 1790753352141,
        type: "session.usage.updated",
        data: {
          sessionID: "ses_f0ec85cf6ffebfalpvV2E9nocu",
          cost: 0,
          tokens: { input: 8927, output: 11, reasoning: 0, cache: { read: 487, write: 0 } },
        },
      },
    },
  },
  {
    type: "emit_inbound",
    label: "session.execution.succeeded",
    frame: {
      type: "sdk.event",
      event: {
        id: "evt_0f137a9ce001qLIAQz6psEXDM3",
        created: 1790753352142,
        type: "session.execution.succeeded",
        data: { sessionID: "ses_f0ec85cf6ffebfalpvV2E9nocu" },
        durable: { aggregateID: "ses_f0ec85cf6ffebfalpvV2E9nocu", seq: 10, version: 1 },
      },
    },
  },
  {
    type: "expect_outbound",
    label: "session.remove",
    frame: { type: "session.remove", input: { sessionID: "ses_f0ec85cf6ffebfalpvV2E9nocu" } },
  },
  {
    type: "emit_inbound",
    label: "session.remove.response",
    frame: { type: "sdk.response", operation: "session.remove", data: null },
  },
];
