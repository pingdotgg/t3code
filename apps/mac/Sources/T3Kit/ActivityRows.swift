// Refined "work log" row derivation from raw orchestration activities.
// The server projects provider-runtime events into append-only activities
// whose kind/summary/payload are wire-shaped (ProviderRuntimeIngestion.ts):
// rendered verbatim they read as "tool.started" / "Reasoning update" spam.
// This mirrors the web client's deriveWorkLogEntries (session-logic.ts):
// lifecycle noise is dropped, and tool events carry their human title + payload
// detail. Rows carry a stable id so lifecycle updates for the same tool call
// *replace* the prior row instead of stacking — the app layer upserts by id.

import Foundation

/// Display phase of a tool row, folded from the wire `status` strings and
/// the activity kind's lifecycle position.
public enum T3ActivityRowPhase: Sendable, Equatable {
    case running, succeeded, failed
}

/// One display-ready timeline row derived from a generic (non-approval,
/// non-typed) activity. UI-agnostic so it stays testable in T3KitTests.
public enum T3ActivityRow: Sendable, Equatable {
    /// `itemType` is the wire item type ("command_execution", "file_change",
    /// …) when the payload carries one; UIs use it to pick icons and detail
    /// rendering (command vs diff vs plain text).
    case tool(id: String, title: String, detail: String, itemType: String?, phase: T3ActivityRowPhase)
    /// Streaming task/reasoning progress ("what the agent is thinking now");
    /// successive updates of the same task share an id and replace in place.
    case reasoning(id: String, text: String)
    case notice(id: String, text: String)
}

public enum ActivityRows {
    /// Derives the display row for an activity; nil means the activity is
    /// pure lifecycle noise and gets no timeline row at all.
    public static func row(for activity: OrchestrationThreadActivity) -> T3ActivityRow? {
        switch activity.kind {
        // `tool.started` is always superseded by `tool.updated`/`.completed`
        // for the same call; the context-window kind feeds the meter side
        // channel, never the timeline.
        case ActivityKind.toolStarted, ActivityKind.contextWindowUpdated:
            return nil

        case ActivityKind.taskStarted, ActivityKind.taskProgress, ActivityKind.taskCompleted:
            // Task lifecycle rows are stateful. LiveBackend folds them through
            // T3SubagentTaskActivityState before calling this generic mapper;
            // mapping one event here would split/lose lifecycle aggregation.
            return nil

        case ActivityKind.runtimeWarning:
            // Unknown-SDK-message warnings whose whole body is the server's
            // no-content marker (describeUnknownSdkMessage) carry nothing a
            // user can act on — e.g. Claude's 'commands_changed' pushes in
            // threads persisted before the server learned to ignore them.
            // Warnings with real preview text keep their notice row via the
            // tone fallthrough below.
            if activity.summary.hasSuffix("(no displayable text content)") {
                return nil
            }

        case ActivityKind.toolUpdated, ActivityKind.toolCompleted:
            // ExitPlanMode markers are internal plan-boundary bookkeeping,
            // not user-facing tool work (web: isPlanBoundaryToolActivity).
            if let detail = activity.payload.objectValue?["detail"]?.stringValue,
                detail.hasPrefix("ExitPlanMode:")
            {
                return nil
            }
            return toolRow(for: activity)

        default:
            break
        }

        switch activity.tone {
        case .tool:
            return .tool(
                id: activity.id, title: nonEmpty(activity.summary) ?? activity.kind,
                detail: payloadDetail(activity.payload) ?? "", itemType: nil, phase: .succeeded)
        case .error:
            return .tool(
                id: activity.id, title: nonEmpty(activity.summary) ?? "Error",
                detail: payloadDetail(activity.payload) ?? "", itemType: nil, phase: .failed)
        case .info, .approval:
            // "Checkpoint captured" duplicates the dedicated checkpoint row.
            guard let text = nonEmpty(activity.summary), text != "Checkpoint captured" else {
                return nil
            }
            return .notice(id: activity.id, text: text)
        }
    }

    private static func toolRow(for activity: OrchestrationThreadActivity) -> T3ActivityRow {
        let payload = activity.decodePayload(ToolLifecycleActivityPayload.self)
        let title =
            nonEmpty(normalizeToolTitle(activity.summary))
            ?? humanizedItemType(payload?.itemType) ?? "Tool"
        var detail =
            detailFromData(activity.payload, itemType: payload?.itemType)
            ?? nonEmpty(payload?.detail).map(stripTrailingExitCode) ?? ""
        // A detail that just restates the title is dead weight in the
        // disclosure body.
        if compactLabel(detail) == compactLabel(title) { detail = "" }

        let phase: T3ActivityRowPhase
        switch payload?.status {
        case "inProgress": phase = .running
        case "failed", "declined", "stopped": phase = .failed
        default: phase = activity.kind == ActivityKind.toolCompleted ? .succeeded : .running
        }

        // toolCallId (payload.data.toolCallId) correlates every lifecycle
        // event of one tool invocation — sharing it as the row id makes
        // updated -> completed replace the same row.
        let id = toolCallId(in: activity.payload).map { "tool:\($0)" } ?? activity.id
        return .tool(
            id: id, title: title, detail: detail, itemType: nonEmpty(payload?.itemType),
            phase: phase)
    }

    private static func toolCallId(in payload: JSONValue) -> String? {
        nonEmpty(payload.objectValue?["data"]?.objectValue?["toolCallId"]?.stringValue)
    }

    /// Rebuilds the detail string from `payload.data` (`{ toolName, input }`,
    /// which ingestion passes through verbatim) when the tool kind has a
    /// structured rendering. `payload.detail` is truncated server-side
    /// (~180 chars), so real file edits and long command lines only survive
    /// via the raw input.
    private static func detailFromData(_ payload: JSONValue, itemType: String?) -> String? {
        guard let data = payload.objectValue?["data"]?.objectValue,
            let input = data["input"]?.objectValue
        else { return nil }
        let toolName = nonEmpty(data["toolName"]?.stringValue) ?? "Tool"

        switch itemType {
        case "command_execution":
            guard let command = nonEmpty((input["command"] ?? input["cmd"])?.stringValue)
            else { return nil }
            return "\(toolName): \(command)"
        case "file_change":
            let hasPath = ["file_path", "path", "filePath"].contains { input[$0] != nil }
            guard hasPath else { return nil }
            var subset: [String: JSONValue] = [:]
            for key in [
                "file_path", "path", "filePath", "old_string", "new_string", "content", "edits",
            ] {
                if let value = input[key] { subset[key] = value }
            }
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            guard let encoded = try? encoder.encode(JSONValue.object(subset)),
                let json = String(data: encoded, encoding: .utf8)
            else { return nil }
            return "\(toolName): \(json)"
        default:
            return nil
        }
    }

    /// Best-effort human detail for activities without a typed payload.
    private static func payloadDetail(_ payload: JSONValue) -> String? {
        guard let object = payload.objectValue else { return nil }
        for key in ["detail", "message"] {
            if let value = nonEmpty(object[key]?.stringValue) {
                return stripTrailingExitCode(value)
            }
        }
        return nil
    }

    /// Some providers title completion events "<Tool> completed"; the phase
    /// icon already says so.
    private static func normalizeToolTitle(_ value: String) -> String {
        value.replacingOccurrences(
            of: #"\s+(?:complete|completed)\s*$"#, with: "", options: [.regularExpression, .caseInsensitive]
        ).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// "command_execution" -> "Command execution".
    private static func humanizedItemType(_ itemType: String?) -> String? {
        guard let itemType = nonEmpty(itemType) else { return nil }
        let words = itemType.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// Drops the runtime's trailing `<exited with exit code N>` marker; the
    /// row's phase already encodes success/failure.
    private static func stripTrailingExitCode(_ value: String) -> String {
        value.replacingOccurrences(
            of: #"\s*<exited with exit code \d+>\s*$"#, with: "",
            options: [.regularExpression, .caseInsensitive]
        ).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func compactLabel(_ value: String) -> String {
        value.split(whereSeparator: \.isWhitespace).joined(separator: " ").lowercased()
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
            !trimmed.isEmpty
        else { return nil }
        return trimmed
    }
}
