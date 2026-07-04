// Mapping helpers: turn wire-shaped orchestration models (ISO date strings,
// interleaved messages/activities/proposed-plans, wire enums) into
// UI-agnostic native Swift values. T3Kit cannot depend on SergeCodeMac (the
// reverse is true, per Package.swift), so this file does not produce
// SergeCodeMac.Entities types directly — it does the wire-quirk
// interpretation (date parsing, chronological merge of a thread's three
// separate append-only lists, best-effort extraction from opaque
// `Schema.Unknown` activity payloads) so the app layer's BackendService
// adapter only has to do a thin, mechanical conversion into its own
// `Project`/`ChatThread`/`TimelineItem`/... types.

import Foundation

public enum WireDate {
    // `ISO8601DateFormatter` is a `class` and not `Sendable`, but these
    // instances are configured once at initialization and only ever used
    // for read-only `date(from:)` parsing afterward, so shared concurrent
    // access is safe in practice; `nonisolated(unsafe)` opts out of the
    // compiler's (overly conservative) global-actor-isolation suggestion.
    nonisolated(unsafe) private static let withFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    nonisolated(unsafe) private static let whole: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// Parses an `IsoDateTime` wire string (§5.1). Tries the fractional-
    /// seconds form first (the server's actual `DateTime.formatIso` output),
    /// falling back to whole seconds for leniency.
    public static func parse(_ iso: String) -> Date? {
        withFractional.date(from: iso) ?? whole.date(from: iso)
    }
}

/// A single, chronologically-ordered entry in a thread's UI timeline,
/// merged from `OrchestrationThread.messages` + `.activities` +
/// `.proposedPlans` + `.checkpoints` (each a separate append-only wire list).
public enum T3TimelineEntry: Sendable {
    case userMessage(id: String, text: String, at: Date)
    case assistantMessage(id: String, markdown: String, isStreaming: Bool, at: Date)
    /// `OrchestrationThreadActivity` with a tone other than `.approval`
    /// (`.info`/`.tool`/`.error`) — tool events and inline notices.
    case activity(OrchestrationThreadActivity, at: Date)
    /// `OrchestrationThreadActivity` with tone `.approval`. `payload` is
    /// `Schema.Unknown` on the wire (provider-specific); `bestEffortRequestId`
    /// is a heuristic extraction from common key names and MUST be verified
    /// against the actual provider-runtime payload shape before being wired
    /// to `T3Client.respondToApproval` — see the file-level open question in
    /// this slice's summary.
    case approvalActivity(OrchestrationThreadActivity, bestEffortRequestId: String?, at: Date)
    case checkpoint(OrchestrationCheckpointSummary, at: Date)
    case proposedPlan(OrchestrationProposedPlan, at: Date)

    public var sortDate: Date {
        switch self {
        case .userMessage(_, _, let at),
            .assistantMessage(_, _, _, let at),
            .activity(_, let at),
            .approvalActivity(_, _, let at),
            .checkpoint(_, let at),
            .proposedPlan(_, let at):
            return at
        }
    }
}

public enum OrchestrationMapping {
    /// Flattens one thread's message/activity/plan/checkpoint lists into a
    /// single chronological timeline. Entries with an unparseable `createdAt`
    /// are dropped (defensive: a malformed date should not crash the UI).
    public static func timeline(for thread: OrchestrationThread) -> [T3TimelineEntry] {
        var entries: [T3TimelineEntry] = []
        entries.reserveCapacity(
            thread.messages.count + thread.activities.count + thread.proposedPlans.count
                + thread.checkpoints.count)

        for message in thread.messages {
            guard let at = WireDate.parse(message.createdAt) else { continue }
            switch message.role {
            case .user:
                entries.append(.userMessage(id: message.id, text: message.text, at: at))
            case .assistant:
                entries.append(
                    .assistantMessage(id: message.id, markdown: message.text, isStreaming: message.streaming, at: at))
            case .system:
                // System messages have no dedicated UI timeline case today;
                // surface them as a tool-tone activity-shaped notice instead
                // of silently dropping them.
                entries.append(
                    .activity(
                        OrchestrationThreadActivity(
                            id: message.id, tone: .info, kind: "system-message", summary: message.text,
                            payload: .null, turnId: message.turnId, createdAt: message.createdAt),
                        at: at))
            }
        }

        for activity in thread.activities {
            guard let at = WireDate.parse(activity.createdAt) else { continue }
            if activity.tone == .approval {
                entries.append(
                    .approvalActivity(activity, bestEffortRequestId: extractRequestId(from: activity.payload), at: at))
            } else {
                entries.append(.activity(activity, at: at))
            }
        }

        for plan in thread.proposedPlans {
            guard let at = WireDate.parse(plan.createdAt) else { continue }
            entries.append(.proposedPlan(plan, at: at))
        }

        for checkpoint in thread.checkpoints {
            guard let at = WireDate.parse(checkpoint.completedAt) else { continue }
            entries.append(.checkpoint(checkpoint, at: at))
        }

        return entries.sorted { $0.sortDate < $1.sortDate }
    }

    /// Best-effort extraction of a `requestId` from an opaque
    /// `OrchestrationThreadActivity.payload` (tone `.approval`). Tries the
    /// common key spellings; returns `nil` if none match, in which case the
    /// caller must fall back to some other correlation strategy (or this
    /// helper needs updating once the true payload shape is confirmed).
    public static func extractRequestId(from payload: JSONValue) -> String? {
        guard let object = payload.objectValue else { return nil }
        for key in ["requestId", "request_id", "approvalRequestId"] {
            if let value = object[key]?.stringValue { return value }
        }
        return nil
    }

    /// Maps a `ProviderApprovalDecision` from a simple "approve or not"
    /// choice, the shape most approval UIs actually offer.
    public static func approvalDecision(approve: Bool) -> ProviderApprovalDecision {
        approve ? .accept : .decline
    }
}
