import Foundation

struct OrchestrationV2DisplayRow: Sendable {
    var message: OrchestrationMessage?
    var activities: [OrchestrationActivity] = []
}

/// V2-to-native display mapping only. These records are never V1 wire events.
public enum OrchestrationV2Presentation {
    /// Metadata refreshes never replace the project list or thread cursors.
    public static func mergingRepositoryIdentities(
        _ projects: [OrchestrationProject], updates: [OrchestrationProject], resolvedRoots: Set<String>
    ) -> [OrchestrationProject] {
        let byID = Dictionary(updates.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        return projects.map { project in
            guard let update = byID[project.id], update.workspaceRoot == project.workspaceRoot else { return project }
            guard resolvedRoots.contains(project.workspaceRoot)
                    || (project.repositoryIdentity == nil && update.repositoryIdentity != nil) else { return project }
            var next = project
            next.repositoryIdentity = update.repositoryIdentity
            return next
        }
    }

    public static func shellSnapshot(_ json: JSONValue) throws -> OrchestrationShellSnapshot {
        try shellSnapshot(json.decode(OrchestrationV2ShellSnapshot.self))
    }

    public static func shellSnapshot(_ snapshot: OrchestrationV2ShellSnapshot) throws -> OrchestrationShellSnapshot {
        guard snapshot.snapshotSequence >= 0, snapshot.schemaVersion > 0 else {
            throw OrchestrationV2StateError.invalidPayload("shell sequence")
        }
        let threads = (snapshot.threads + snapshot.archivedThreads).map(shellThread)
        let updatedAt = (threads.map(\.updatedAt) + snapshot.projects.map(\.updatedAt)).max()
            ?? "1970-01-01T00:00:00.000Z"
        return OrchestrationShellSnapshot(
            snapshotSequence: snapshot.snapshotSequence,
            projects: snapshot.projects, threads: threads, updatedAt: updatedAt,
            orchestrationProtocolVersion: 2
        )
    }

    public static func shellStreamItem(_ json: JSONValue) -> ShellStreamItem {
        do {
            switch json["kind"]?.stringValue {
            case "synchronized": return .synchronized
            case "snapshot":
                if let roots = json["resolvedRepositoryIdentityRoots"] {
                    let resolved = try roots.decode([String].self)
                    let projects = try json.v2Required("snapshot").v2Required("projects").decode([OrchestrationProject].self)
                    return .repositoryIdentitiesUpdated(projects: projects, resolvedRoots: Set(resolved))
                }
                return .snapshot(try shellSnapshot(json.v2Required("snapshot")))
            case "project.updated":
                return try .projectUpserted(sequence: sequence(json), project: json.v2Required("project").decode(OrchestrationProject.self))
            case "project.removed":
                guard let id = json["projectId"]?.stringValue else { return .refreshRequired }
                return try .projectRemoved(sequence: sequence(json), projectID: id)
            case "thread.updated":
                guard ["active", "archive"].contains(json["location"]?.stringValue ?? "") else { return .refreshRequired }
                return try .threadUpserted(sequence: sequence(json), thread: shellThread(OrchestrationV2ThreadShell(json: json.v2Required("thread"))))
            case "thread.removed":
                guard let id = json["threadId"]?.stringValue,
                      ["active", "archive"].contains(json["location"]?.stringValue ?? "") else { return .refreshRequired }
                // The shell store contains both locations. Moving to archive sends
                // a removal followed by the authoritative archive upsert.
                return try .threadRemoved(sequence: sequence(json), threadID: id)
            default: return .refreshRequired
            }
        } catch { return .refreshRequired }
    }

    public static func shellThread(_ shell: OrchestrationV2ThreadShell) -> OrchestrationThreadShell {
        let t = shell.thread
        let activeStatus = shell.activityRunStatus ?? shell.status
        let latest = shell.latestRunId.map { id in
            OrchestrationLatestTurn(
                turnId: id, state: turnState(shell.status),
                requestedAt: shell.latestRunRequestedAt ?? shell.activityRunStartedAt ?? t.updatedAt,
                startedAt: shell.latestRunStartedAt ?? shell.activityRunStartedAt,
                completedAt: shell.latestRunCompletedAt, assistantMessageId: nil
            )
        }
        return OrchestrationThreadShell(
            relationshipToParent: t.lineage.relationshipToParent,
            id: t.id, projectId: t.projectId, title: t.title, modelSelection: t.modelSelection,
            runtimeMode: t.runtimeMode, interactionMode: t.interactionMode, branch: t.branch,
            worktreePath: t.worktreePath, linkedPullRequest: t.linkedPullRequest,
            pullRequests: t.pullRequests, branchPullRequest: t.branchPullRequest, latestTurn: latest,
            createdAt: t.createdAt, updatedAt: t.updatedAt, archivedAt: t.archivedAt,
            settledOverride: t.settledOverride, settledAt: t.settledAt, unsettledAt: t.unsettledAt,
            activeOrderKey: t.activeOrderKey, autoSettleDisabledAt: t.autoSettleDisabledAt,
            snoozedUntil: t.snoozedUntil, snoozedAt: t.snoozedAt, pinnedAt: t.pinnedAt,
            pinOrderKey: t.pinOrderKey, titleRegeneration: t.titleRegeneration,
            session: session(thread: t, status: activeStatus, activeRunID: shell.activeRunId,
                             lastError: shell.lastError, updatedAt: t.updatedAt),
            latestUserMessageAt: shell.latestUserMessageAt,
            hasPendingApprovals: shell.pendingRuntimeRequest?.isApproval == true,
            hasPendingUserInput: shell.pendingRuntimeRequest?.isUserInput == true,
            hasActionableProposedPlan: shell.hasActionableProposedPlan,
            backgroundLiveness: backgroundLiveness(shell.pendingBackgroundTasks)
                ?? (t.pullRequests?.contains(where: \.isWatched) == true ? .monitoring : nil),
            latestUserAuthoredMessageAt: shell.raw["latestUserAuthoredMessageAt"]?.stringValue,
            latestUserAuthoredMessageAtIsPresent: shell.raw["latestUserAuthoredMessageAt"] != nil,
            v2Lifecycle: OrchestrationV2ThreadLifecycle(shell: shell)
        )
    }

    static func detailSnapshot(
        projection p: OrchestrationV2ThreadProjection,
        sequence: Int, historyCursor: String?, hasMoreHistory: Bool,
        rows: [OrchestrationV2DisplayRow]
    ) -> OrchestrationThreadDetailSnapshot {
        let t = p.thread
        // A queued follow-up must not replace the active run's working state.
        let active = p.runs.filter { ["preparing", "starting", "running", "waiting"].contains($0.status) }.max { $0.ordinal < $1.ordinal }
        let providerSession = p.providerSessions.last { $0.providerInstanceId == t.providerInstanceId }
        let latest = presentedLatestRun(p, sessionError: providerSession?.lastError)
        let displayRun = active ?? latest
        let providerSubagent = t.creationSource == "provider" && t.lineage.relationshipToParent == "subagent"
            ? p.nodes.last { $0.kind == "root_turn" && $0.runId == nil } : nil
        // Cached display rows may predate a history prepend. Positions always
        // come from the current projection, never cached rows or timestamps.
        let positions = Dictionary(p.visibleTurnItems.map { ($0.id, $0.position) }, uniquingKeysWith: { _, last in last })
        let foldedAnswers = Set(rows.flatMap(\.activities).compactMap { activity -> String? in
            guard let source = activity.v2Timeline, source.itemType == "user_input_request",
                  case .object? = activity.v2Item?["questionAnswer"],
                  let requestID = activity.v2Item?["requestId"]?.stringValue else { return nil }
            return "\(source.sourceThreadID.utf8.count):\(source.sourceThreadID)async-answer:\(requestID)"
        })
        let visibleRows = rows.filter { row in
            guard let message = row.message, message.role == "user",
                  let source = message.v2Timeline, let messageID = source.messageID else { return true }
            return !foldedAnswers.contains("\(source.sourceThreadID.utf8.count):\(source.sourceThreadID)\(messageID)")
        }
        let runs = Dictionary(p.runs.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        func updatedMetadata(_ source: OrchestrationV2TimelineMetadata?) -> OrchestrationV2TimelineMetadata? {
            guard var source else { return nil }
            source.position = positions[source.projectedID] ?? source.position
            if source.sourceThreadID == t.id, let runID = source.runID, let run = runs[runID] {
                source.runStatus = run.status
                source.runStartedAt = run.workStartedAt ?? run.startedAt
                source.runCompletedAt = run.completedAt
            }
            return source
        }
        let messages = visibleRows.compactMap(\.message).map { message in
            var message = message
            message.v2Timeline = updatedMetadata(message.v2Timeline)
            return message
        }
        var activities = visibleRows.flatMap(\.activities).map { activity in
            var activity = activity
            activity.v2Timeline = updatedMetadata(activity.v2Timeline)
            return activity
        }
        let timeline = visibleRows.compactMap { row -> OrchestrationV2TimelineRow? in
            guard let identity = row.message?.v2Timeline ?? row.activities.first?.v2Timeline else { return nil }
            return OrchestrationV2TimelineRow(projectedID: identity.projectedID,
                messageID: row.message?.id, activityIDs: row.activities.map(\.id))
        }
        appendControlActivities(p, to: &activities)
        // One pass so per-checkpoint lookups stay O(1); later messages win, like `.last`.
        var lastAssistantIDByTurn: [String: String] = [:]
        for message in messages where message.role == "assistant" {
            if let turnID = message.turnId { lastAssistantIDByTurn[turnID] = message.id }
        }
        let latestTurn = displayRun.map { run in
            OrchestrationLatestTurn(
                turnId: run.id, state: turnState(run.status), requestedAt: run.requestedAt,
                startedAt: run.workStartedAt ?? run.startedAt, completedAt: run.completedAt,
                assistantMessageId: lastAssistantIDByTurn[run.id]
            )
        } ?? providerSubagent.map { node in
            // This is a display identity only. The controls retain no app run,
            // so stop, queue and steer never dispatch this ID as a run.
            OrchestrationLatestTurn(turnId: "v2-node:\(node.id)", state: turnState(node.status),
                                    requestedAt: node.startedAt ?? t.createdAt, startedAt: node.startedAt,
                                    completedAt: node.completedAt, assistantMessageId: messages.last { $0.role == "assistant" }?.id)
        }
        let checkpoints = p.checkpoints.compactMap { checkpoint -> CheckpointSummary? in
            guard let runID = checkpoint.runId, let ordinal = checkpoint.appRunOrdinal,
                  runs[runID]?.status != "rolled_back" else { return nil }
            return CheckpointSummary(
                turnId: runID, checkpointTurnCount: ordinal, checkpointRef: checkpoint.ref,
                status: checkpoint.status, files: checkpoint.files,
                assistantMessageId: lastAssistantIDByTurn[runID],
                completedAt: checkpoint.capturedAt
            )
        }.sorted { $0.checkpointTurnCount < $1.checkpointTurnCount }
        let failure = rootFailure(displayRun, items: p.turnItems)
        let lastError = providerSession?.lastError ?? failure?.message
        var native = OrchestrationThread(
            relationshipToParent: t.lineage.relationshipToParent,
            id: t.id, projectId: t.projectId, title: t.title, modelSelection: t.modelSelection,
            runtimeMode: t.runtimeMode, interactionMode: t.interactionMode, branch: t.branch,
            worktreePath: t.worktreePath, linkedPullRequest: t.linkedPullRequest,
            pullRequests: t.pullRequests, branchPullRequest: t.branchPullRequest, latestTurn: latestTurn,
            createdAt: t.createdAt, updatedAt: p.updatedAt, archivedAt: t.archivedAt,
            settledOverride: t.settledOverride, settledAt: t.settledAt, unsettledAt: t.unsettledAt,
            activeOrderKey: t.activeOrderKey, autoSettleDisabledAt: t.autoSettleDisabledAt,
            snoozedUntil: t.snoozedUntil, snoozedAt: t.snoozedAt, pinnedAt: t.pinnedAt,
            pinOrderKey: t.pinOrderKey, titleRegeneration: t.titleRegeneration, deletedAt: t.deletedAt,
            messages: messages, activities: activities, checkpoints: checkpoints,
            session: session(thread: t, status: providerSubagent?.status ?? displayRun?.status ?? "idle", activeRunID: active?.id,
                             lastError: lastError, updatedAt: p.updatedAt),
            orchestrationV2Control: controlState(p)
        )
        native.v2Timeline = timeline
        var snapshot = OrchestrationThreadDetailSnapshot(
            snapshotSequence: sequence, thread: native,
            page: OrchestrationThreadDetailPage(beforeCursor: historyCursor, hasMore: hasMoreHistory,
                                                snapshotSequence: sequence, threadSequence: sequence)
        )
        snapshot.orchestrationProtocolVersion = 2
        return snapshot
    }

    private static func controlState(_ p: OrchestrationV2ThreadProjection) -> JSONValue {
        let recoveryItems: [JSONValue] = p.turnItems.filter {
            $0.threadId == p.thread.id && $0.type == "error"
        }.map { item in
            .object(item.raw.v2Object.filter {
                ["id", "threadId", "type", "status", "runId", "nodeId", "ordinal", "updatedAt", "failure"].contains($0.key)
            })
        }
        let assistantItems: [JSONValue] = p.visibleTurnItems.filter { $0.item.type == "assistant_message" }.map { row in
            let item: JSONValue = .object([
                "id": .string(row.item.id), "threadId": .string(row.item.threadId),
                "runId": row.item.runId.map(JSONValue.string) ?? .null,
                "type": .string(row.item.type), "status": .string(row.item.status),
                "providerThreadId": row.item.providerThreadId.map(JSONValue.string) ?? .null,
            ])
            return .object(["sourceThreadId": .string(row.sourceThreadId),
                "sourceItemId": .string(row.sourceItemId), "item": item])
        }
        return .object([
            "thread": p.thread.raw, "runs": .array(p.runs.map(\.raw)),
            "lifecycle": (try? JSONValue.encode(OrchestrationV2ThreadLifecycle(projection: p))) ?? .null,
            "recoveryTurnItems": .array(recoveryItems),
            "messages": .array(p.messages.map(\.raw)), "nodes": .array(p.nodes.map(\.raw)),
            "attempts": .array(p.attempts.map(\.raw)), "providerThreads": .array(p.providerThreads.map(\.raw)),
            "subagents": .array(p.subagents.map(\.raw)), "visibleTurnItems": .array(assistantItems),
            "providerTurns": .array(p.providerTurns.map(\.raw)), "providerSessions": .array(p.providerSessions.map(\.raw)),
            "backgroundTurnItems": .array(p.turnItems.compactMap { backgroundControlItem($0.raw) }),
        ])
    }

    static func displayRow(_ row: OrchestrationV2ProjectedTurnItem, projection p: OrchestrationV2ThreadProjection) -> OrchestrationV2DisplayRow {
        let item = row.item
        let raw = item.raw
        if ["todo_list", "checkpoint", "run_interrupt_request"].contains(item.type)
            || (item.type == "command_execution" && raw["input"]?.stringValue == "Preparing workspace")
            || (item.type == "error" && item.status == "cancelled"
                && raw["failure"]?["code"]?.stringValue == "workspace_preparation_failed") { return OrchestrationV2DisplayRow() }
        var source = OrchestrationV2TimelineMetadata(row)
        if let nodeID = item.nodeId {
            var nodeID: String? = nodeID
            var visited: Set<String> = []
            while let current = nodeID, visited.insert(current).inserted {
                if let attempt = p.attempts.first(where: { $0.rootNodeId == current && $0.runId == item.runId }) {
                    source.attemptID = attempt.id
                    break
                }
                guard let node = p.nodes.first(where: { $0.id == current }) else { break }
                if let attempt = p.attempts.first(where: { $0.rootNodeId == node.rootNodeId && $0.runId == item.runId }) {
                    source.attemptID = attempt.id
                    break
                }
                nodeID = node.parentNodeId
            }
        }
        let createdAt = item.startedAt ?? item.updatedAt
        // Source-scoped inherited IDs do not collide with a fork's local items.
        let itemID = row.isLocal ? item.id : "v2-inherited:\(row.id)"
        let turnID = item.runId.map { row.isLocal ? $0 : "v2-inherited:\(row.sourceThreadId):\($0)" }
        var result = OrchestrationV2DisplayRow()
        func message(_ id: String, role: String, text: String, streaming: Bool = false,
                     attachments: [ChatAttachment]? = nil, context: OrchestrationMessageContext? = nil) -> OrchestrationMessage {
            OrchestrationMessage(v2Timeline: source, id: row.isLocal ? id : "v2-inherited:\(row.sourceThreadId.utf8.count):\(row.sourceThreadId)\(id)",
                                 role: role, text: text, attachments: attachments, turnId: turnID,
                                 streaming: row.isLocal && streaming, createdAt: createdAt,
                                 updatedAt: item.updatedAt, context: context)
        }
        func activity(_ kind: String, _ summary: String, tone: String = "info", fields: [String: JSONValue] = [:],
                      idSuffix: String? = nil, occurredAt: String? = nil,
                      inspection: JSONValue? = nil) -> OrchestrationActivity {
            var payload = raw.v2Object
            fields.forEach { payload[$0.key] = $0.value }
            if !row.isLocal, let requestID = payload["requestId"]?.stringValue {
                payload["requestId"] = .string("v2-inherited:\(row.id):\(requestID)")
            }
            payload["v2ItemId"] = .string(item.id)
            payload["v2Visibility"] = .string(row.visibility)
            return OrchestrationActivity(v2Timeline: source, v2Item: inspection ?? raw, id: "v2:\(itemID):\(idSuffix ?? (kind.hasPrefix("task.") ? "task" : "activity"))", tone: tone, kind: kind, summary: summary,
                                         payload: .object(payload), turnId: turnID, sequence: item.ordinal, createdAt: occurredAt ?? createdAt)
        }
        func tool(_ title: String, detail: String, extra: [String: JSONValue] = [:], status: String? = nil, inspection: JSONValue? = nil) -> OrchestrationActivity {
            let status = status ?? item.status
            let active = row.isLocal && ["pending", "running", "waiting"].contains(status)
            var fields = extra
            fields["toolCallId"] = .string(itemID)
            fields["title"] = .string(item.title ?? title)
            fields["detail"] = .string(detail)
            fields["itemType"] = .string(item.type == "dynamic_tool" ? "dynamic_tool_call" : item.type)
            fields["status"] = .string(active ? "inProgress" : status)
            return activity("tool.updated",
                            item.title ?? title, tone: status == "failed" ? "error" : "info", fields: fields, inspection: inspection)
        }
        switch item.content {
        case let .userMessage(id, intent, text, attachments, context):
            // Pending queued input belongs in the composer queue, never twice in the transcript.
            if row.isLocal, intent == "queued_turn", let runID = item.runId,
               p.runs.first(where: { $0.id == runID })?.status == "queued" { break }
            result.message = message(id, role: "user", text: text, attachments: attachments, context: context)
        case let .assistantMessage(id, text, streaming, attachments):
            result.message = message(id, role: "assistant", text: text, streaming: streaming, attachments: attachments)
        case let .reasoning(text, streaming):
            result.activities = [tool(streaming ? "Thinking" : "Thought", detail: text)]
        case let .proposedPlan(_, markdown, streaming):
            result.message = message("v2-plan:\(itemID)", role: "assistant", text: markdown, streaming: streaming)
        case let .todoList(_, steps, explanation):
            let text = ([explanation].compactMap { $0 } + steps.map {
                "\($0.status == "completed" ? "[x]" : "[ ]") \($0.text)"
            }).joined(separator: "\n")
            result.activities = [tool("Plan", detail: text)]
        case let .userInput(requestID, questions, responseMode):
            let request = row.isLocal ? p.runtimeRequests.first { $0.id == requestID } : nil
            let answer = raw["questionAnswer"]
            // Older V2 servers saved answers on the resolved request only.
            let answers = answer?["answers"] ?? (request?.status == "resolved" ? request?.answers : nil)
            let pending = answers == nil && request?.status == "pending"
            var fields: [String: JSONValue] = ["requestId": .string(requestID), "questions": .array(questions.map(\.raw))]
            if responseMode == "message" || request?.responseCapability.type == "message" { fields["responseMode"] = .string("message") }
            fields["responseCapability"] = request?.raw["responseCapability"] ?? raw["responseCapability"]
            var inspection = raw.v2Object
            inspection["responseCapability"] = fields["responseCapability"]
            inspection["requestStatus"] = request.map { .string($0.status) }
            if inspection["questionAnswer"] == nil, let answers {
                inspection["questionAnswer"] = .object([
                    "requestId": .string(requestID), "answers": answers,
                    "attachmentsByQuestionId": .object([:]),
                    "questionTextById": .object(Dictionary(questions.map { ($0.id, JSONValue.string($0.question)) }, uniquingKeysWith: { _, last in last })),
                ])
            }
            result.activities = [activity(row.isLocal && pending ? "user-input.requested" : "user-input.resolved",
                item.title ?? "Input requested", fields: fields, inspection: .object(inspection))]
            if case .object? = answers {
                // NativeQuestionAnswerHistory reads these fields at the payload
                // root. Inherited answers are history, never request controls.
                var questionText = Dictionary(questions.map { ($0.id, JSONValue.string($0.question)) }, uniquingKeysWith: { _, last in last })
                answer?["questionTextById"]?.v2Object.forEach { questionText[$0.key] = $0.value }
                fields["answers"] = answers
                fields["attachmentsByQuestionId"] = answer?["attachmentsByQuestionId"] ?? .object([:])
                fields["questionTextById"] = .object(questionText)
                result.activities.append(activity("user-input.answer-submitted", "Question answer submitted", fields: fields,
                    idSuffix: "answer", occurredAt: item.completedAt ?? request?.resolvedAt ?? item.updatedAt))
            }
        case let .secretRequest(request):
            result.activities = [activity("secret.request", request.label)]
        case let .approval(requestID, requestKind, prompt):
            let request = row.isLocal ? p.runtimeRequests.first { $0.id == requestID } : nil
            let pending = request?.status == "pending"
            var fields: [String: JSONValue] = [
                "requestId": .string(requestID), "requestKind": .string(requestKind),
                "requestType": .string(requestKind), "detail": .string(prompt ?? item.title ?? "Approval requested"),
            ]
            for key in ["appName", "options", "responseCapability"] {
                fields[key] = request?.raw[key] ?? raw[key]
            }
            var inspection = raw.v2Object
            for key in ["appName", "options", "responseCapability"] { inspection[key] = fields[key] }
            inspection["requestStatus"] = request.map { .string($0.status) }
            inspection["decision"] = request?.decision.map(JSONValue.string)
            result.activities = [activity(pending ? "approval.requested" : "approval.resolved",
                item.title ?? "Approval requested", fields: fields, inspection: .object(inspection))]
        case let .fileChange(fileName):
            result.activities = [tool("Edit \(fileName)", detail: raw["diffStr"]?.stringValue ?? fileName)]
        case let .command(input, output, exitCode):
            var extra: [String: JSONValue] = ["command": .string(input)]
            if let output { extra["output"] = .string(output) }
            if let exitCode { extra["exitCode"] = .number(Double(exitCode)) }
            result.activities = [tool("Run command", detail: [input, output].compactMap { $0 }.joined(separator: "\n"), extra: extra)]
        case let .fileSearch(pattern): result.activities = [tool("Search files", detail: pattern ?? item.title ?? "Search files")]
        case let .webSearch(patterns): result.activities = [tool("Search web", detail: patterns?.joined(separator: "\n") ?? item.title ?? "Search web")]
        case let .checkpoint(_, _, files):
            result.activities = [tool("Checkpoint", detail: files.map(\.path).joined(separator: "\n"))]
        case let .interruptRequest(text), let .interruptResult(text), let .systemNotice(text):
            result.message = message("v2-notice:\(itemID)", role: "system", text: text)
        case let .failure(failure):
            result.activities = [activity(item.status == "failed" ? "provider.turn.failed" : "provider.turn.status",
                failure.message, tone: item.status == "failed" ? "error" : "info", fields: ["message": .string(failure.message)])]
        case let .compaction(summary):
            result.activities = [activity("context-compaction", summary ?? "Context compacted", fields: ["status": .string(item.status)])]
        case let .handoff(id, summary):
            let handoff = p.contextHandoffs.first { $0.id == id }
            var inspection = raw.v2Object
            let sourceRuns = row.sourceThreadId == p.thread.id ? p.runs : []
            let handoffRun = sourceRuns.first { $0.id == item.runId }
            if raw["fromModelSelections"]?.v2Array?.isEmpty != false {
                inspection["fromModelSelections"] = .array((raw["fromProviderInstanceIds"]?.v2Array ?? []).compactMap { value in
                    guard let instanceID = value.stringValue else { return nil }
                    let previous = sourceRuns.filter { $0.providerInstanceId == instanceID && $0.ordinal < (handoffRun?.ordinal ?? Int.max) }
                        .max { $0.ordinal < $1.ordinal }
                    return .object(["instanceId": .string(instanceID), "model": previous.map { .string($0.modelSelection.model) } ?? .null])
                })
            }
            if inspection["toModel"] == nil, handoffRun?.providerInstanceId == raw["toProviderInstanceId"]?.stringValue {
                inspection["toModel"] = handoffRun.map { .string($0.modelSelection.model) }
            }
            result.activities = [activity("context-handoff", summary ?? handoff?.summaryText ?? "Provider changed", inspection: .object(inspection))]
        case let .fork(target):
            result.message = message("v2-fork:\(itemID)", role: "system", text: item.title ?? "Forked conversation: \(target)")
        case let .threadCreated(target, _, model):
            result.message = message("v2-thread:\(itemID)", role: "system", text: item.title ?? "Started \(model) in \(target)")
        case let .subagent(id, childID, prompt, progress, output):
            // Control-plane subagents below provide the latest status even if this
            // turn item was outside the bounded history window.
            let agent = row.isLocal ? p.subagents.first { $0.id == id } : nil
            var fields: [String: JSONValue] = ["taskId": .string(row.isLocal ? id : itemID), "agentKind": .string("agent"),
                                              "status": .string(row.isLocal ? (agent?.status ?? item.status) : "completed"),
                                              "detail": .string(agent?.progress ?? progress ?? agent?.result ?? output ?? prompt)]
            if let childID { fields["childThreadId"] = .string(childID) }
            var inspection = raw.v2Object
            if let agent {
                for key in ["status", "progress", "result", "title", "model", "driver", "providerInstanceId", "childThreadId", "startedAt", "completedAt"] {
                    if let value = agent.raw[key], value != .null { inspection[key] = value }
                }
            }
            result.activities = [activity("task.updated", item.title ?? agent?.title ?? "Subagent", fields: fields),
                                 tool(item.title ?? "Subagent", detail: agent?.result ?? output ?? agent?.progress ?? progress ?? prompt, status: agent?.status, inspection: .object(inspection))]
        case let .tool(name, input, output):
            var extra: [String: JSONValue] = ["input": input, "output": output ?? .null]
            let imagePath = raw["viewedImagePath"]?.stringValue
            if imagePath != nil { extra["requestKind"] = .string("file-read") }
            result.activities = [tool(name ?? "Tool", detail: imagePath ?? displayText(output) ?? displayText(input) ?? "", extra: extra)]
        case let .notification(summary, detail, _):
            result.activities = [activity("notification", summary, fields: ["detail": .string(detail ?? summary)])]
        }
        return result
    }

    /// Stop needs background item state even outside visible history, but not
    /// command output or tool input. Keep only the fields used by the shared policy.
    static func backgroundControlItem(_ item: JSONValue) -> JSONValue? {
        guard let type = item["type"]?.stringValue,
              ["command_execution", "dynamic_tool", "subagent"].contains(type) else { return nil }
        return .object([
            "type": .string(type), "status": item["status"] ?? .null, "runId": item["runId"] ?? .null,
            "persistent": .bool(type == "dynamic_tool" && item["input"]?["persistent"]?.boolValue == true),
        ])
    }

    private static func appendControlActivities(_ p: OrchestrationV2ThreadProjection, to activities: inout [OrchestrationActivity]) {
        if let failure = p.thread.rollbackFailure,
           let id = failure["requestId"]?.stringValue, let message = failure["message"]?.stringValue {
            activities.append(OrchestrationActivity(id: "v2-rollback-failure:\(id)", tone: "error",
                kind: "checkpoint.revert.failed", summary: message,
                payload: .object(["requestId": .string(id), "detail": .string(message), "message": .string(message)]),
                turnId: nil, sequence: nil, createdAt: p.thread.updatedAt))
        }
        let requestIDs = Set(activities.compactMap { $0.payload["requestId"]?.stringValue })
        for request in p.runtimeRequests where !requestIDs.contains(request.id) {
            // Required live controls normally have turn items in the bounded
            // snapshot. A resolved control can still close an earlier native row.
            guard request.status != "pending" else { continue }
            let input = request.kind == "user_input"
            activities.append(OrchestrationActivity(id: "v2-request:\(request.id)", tone: "info",
                kind: input ? "user-input.resolved" : "approval.resolved", summary: "Request resolved",
                payload: .object(["requestId": .string(request.id)]), turnId: nil, sequence: nil,
                createdAt: request.resolvedAt ?? request.createdAt))
        }
        for agent in p.subagents {
            activities.append(OrchestrationActivity(id: "v2-agent:\(agent.id)", tone: "info", kind: "task.updated",
                summary: agent.title ?? "Subagent",
                payload: .object(["taskId": .string(agent.id), "agentKind": .string("agent"),
                                  "status": .string(agent.status), "detail": .string(agent.progress ?? agent.result ?? agent.prompt)]),
                turnId: agent.runId, sequence: nil, createdAt: agent.startedAt ?? agent.updatedAt))
        }
        for turn in p.providerTurns {
            guard let usage = turn.tokenUsage else { continue }
            let node = p.nodes.first { $0.id == turn.nodeId }
            activities.append(OrchestrationActivity(id: "v2-usage:\(turn.id)", tone: "info", kind: "token-usage",
                summary: "\(usage.usedTokens) tokens", payload: usage.raw, turnId: node?.runId,
                sequence: nil, createdAt: usage.updatedAt))
        }
    }

    /// Mirrors shared/orchestrationV2ThreadError.ts. Held work does not own the
    /// outcome, and queued/cancelled follow-ups must not conceal a usage limit.
    private static func presentedLatestRun(_ p: OrchestrationV2ThreadProjection, sessionError: String?) -> OrchestrationV2Run? {
        let executed = p.runs.filter {
            $0.status != "queued" && !($0.status == "cancelled" && $0.startedAt == nil)
        }.max { left, right in
            if left.completedAt == right.completedAt { return left.ordinal < right.ordinal }
            guard let leftEnd = left.completedAt else { return false }
            guard let rightEnd = right.completedAt else { return true }
            return leftEnd < rightEnd
        }
        if let executed, let failure = rootFailure(executed, items: p.turnItems),
           failure.class == "usage_limit", sessionError == nil || sessionError == failure.message,
           p.runs.contains(where: { $0.ordinal > executed.ordinal }) {
            return executed
        }
        return p.runs.filter { !($0.status == "queued" && $0.queueHeld == true) }
            .max { $0.ordinal < $1.ordinal }
    }

    private static func rootFailure(_ run: OrchestrationV2Run?, items: [OrchestrationV2TurnItem]) -> OrchestrationV2ProviderFailure? {
        guard let run, run.status == "failed" else { return nil }
        let latest = items.filter { $0.type == "error" && $0.status == "failed" && $0.runId == run.id && $0.nodeId == run.rootNodeId }
            .max {
                if $0.updatedAt != $1.updatedAt { return $0.updatedAt < $1.updatedAt }
                if $0.ordinal != $1.ordinal { return $0.ordinal < $1.ordinal }
                return $0.id < $1.id
            }
        guard let latest, case let .failure(failure) = latest.content else { return nil }
        return failure
    }

    private static func session(thread: OrchestrationV2AppThread, status: String, activeRunID: String?, lastError: String?, updatedAt: String) -> OrchestrationSession {
        let nativeStatus: String
        switch status {
        case "queued", "preparing", "starting": nativeStatus = "starting"
        case "pending", "running", "waiting": nativeStatus = "running"
        case "failed": nativeStatus = "error"
        default: nativeStatus = "ready"
        }
        return OrchestrationSession(threadId: thread.id, status: nativeStatus, providerName: nil,
                                    providerInstanceId: thread.providerInstanceId, runtimeMode: thread.runtimeMode,
                                    activeTurnId: activeRunID, lastError: lastError, updatedAt: updatedAt)
    }
    private static func turnState(_ status: String) -> String {
        switch status {
        case "pending", "preparing", "starting", "running", "waiting": "running"
        case "failed": "error"
        case "cancelled", "rolled_back": "interrupted"
        default: status
        }
    }
    private static func backgroundLiveness(_ tasks: [JSONValue]) -> OrchestrationBackgroundLiveness? {
        let holding = tasks.filter { $0["kind"]?.stringValue != "command" }
        guard !holding.isEmpty else { return nil }
        return holding.contains { $0["kind"]?.stringValue != "monitor" } ? .working : .monitoring
    }
    private static func sequence(_ json: JSONValue) throws -> Int {
        guard let sequence = json["sequence"]?.v2Int, sequence >= 0 else {
            throw OrchestrationV2StateError.invalidPayload("shell sequence")
        }
        return sequence
    }
    private static func displayText(_ json: JSONValue?) -> String? {
        guard let json, json != .null else { return nil }
        if let text = json.stringValue { return text }
        guard let data = try? JSONEncoder.t3Intermediate.encode(json) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

public struct OrchestrationV2ProviderGoalPresentation: Equatable, Sendable {
    public let title: String
    public let objective: String
    public let usage: String?
    /// The UI also checks the provider before offering Codex pause/resume commands.
    public let canResume: Bool
}

extension OrchestrationV2Presentation {
    public static func providerGoal(
        _ goal: OrchestrationV2ProviderGoal, working: Bool
    ) -> OrchestrationV2ProviderGoalPresentation {
        let title: String
        switch goal.status {
        case .active: title = working ? "Pursuing goal" : "Goal set"
        case .paused: title = "Goal paused"
        case .blocked: title = "Goal blocked"
        case .usageLimited: title = "Goal hit a usage limit"
        case .budgetLimited: title = "Goal reached its token budget"
        case .complete: title = "Goal complete"
        }
        func tokens(_ count: Int) -> String {
            if count < 1_000 { return String(count) }
            if count < 1_000_000 { return "\(Int((Double(count) / 1_000).rounded()))k" }
            let value = String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), Double(count) / 1_000_000)
            return "\(value.hasSuffix(".0") ? String(value.dropLast(2)) : value)m"
        }
        var usage: [String] = []
        if let used = goal.tokensUsed, used > 0 {
            usage.append(goal.tokenBudget.map { "\(tokens(used)) / \(tokens($0)) tokens" } ?? "\(tokens(used)) tokens")
        }
        if let seconds = goal.timeUsedSeconds, seconds >= 60 {
            let minutes = seconds / 60
            usage.append(minutes < 60 ? "\(minutes)m" : "\(minutes / 60)h \(minutes % 60)m")
        }
        if let checks = goal.checks, checks > 0 { usage.append("\(checks) \(checks == 1 ? "check" : "checks")") }
        return OrchestrationV2ProviderGoalPresentation(title: title, objective: goal.objective,
            usage: usage.isEmpty ? nil : usage.joined(separator: " · "),
            canResume: goal.status != .active && goal.status != .complete)
    }
}
