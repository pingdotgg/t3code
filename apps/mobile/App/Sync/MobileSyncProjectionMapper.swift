import Foundation
import T3MobileProtocol

struct MobileSyncProjectionMapper: Sendable {
    func environment(from descriptor: MobileDescriptorResult) -> MobileEnvironment {
        MobileEnvironment(
            id: descriptor.environment.environmentId,
            title: descriptor.environment.label,
            connectionSummary: "\(descriptor.environment.platform.os) / \(descriptor.environment.platform.arch)",
            isConnected: true
        )
    }

    func shellState(from stream: MobileStreamMessage) throws -> MobileShellState {
        guard stream.payload.kind == "snapshot", let snapshot = stream.payload.snapshot else {
            throw MobileSyncError.unexpectedMessage("Expected shell snapshot stream item.")
        }
        let dto = try MobileShellSnapshotDTO(snapshot)
        return MobileShellState(
            snapshotSequence: dto.snapshotSequence,
            projects: dto.projects.map { project in
                MobileProject(
                    id: project.id,
                    title: project.title,
                    workspaceRoot: project.workspaceRoot
                )
            },
            threads: dto.threads.map { thread in
                MobileThread(
                    id: thread.id,
                    projectID: thread.projectId,
                    title: thread.title,
                    status: threadStatus(thread),
                    latestSummary: latestSummary(thread)
                )
            }
        )
    }

    func threadDetail(from stream: MobileStreamMessage) throws -> MobileThreadDetail {
        guard stream.payload.kind == "snapshot", let snapshot = stream.payload.snapshot else {
            throw MobileSyncError.unexpectedMessage("Expected thread snapshot stream item.")
        }
        return try threadDetail(fromSnapshot: snapshot)
    }

    func threadDetail(fromSnapshot snapshot: JSONValue) throws -> MobileThreadDetail {
        let dto = try MobileThreadDetailSnapshotDTO(snapshot)
        return makeThreadDetail(
            threadID: dto.thread.id,
            title: dto.thread.title,
            snapshotSequence: dto.snapshotSequence,
            messages: dto.thread.messages.map {
                MobileChatMessage(
                    id: $0.id,
                    role: $0.role,
                    text: $0.text,
                    streaming: $0.streaming,
                    createdAt: $0.createdAt
                )
            },
            activities: dto.thread.activities.map {
                MobileThreadActivity(
                    id: $0.id,
                    tone: $0.tone,
                    kind: $0.kind,
                    summary: $0.summary,
                    createdAt: $0.createdAt,
                    requestID: $0.requestID,
                    interactionKind: $0.interactionKind
                )
            },
            proposedPlans: dto.thread.proposedPlans.map {
                MobileProposedPlan(
                    id: $0.id,
                    turnID: $0.turnID,
                    markdown: $0.markdown,
                    implementedAt: $0.implementedAt,
                    createdAt: $0.createdAt
                )
            },
            checkpoints: dto.thread.checkpoints.map {
                MobileCheckpointSummary(
                    id: "\($0.turnID):\($0.turnCount)",
                    turnID: $0.turnID,
                    turnCount: $0.turnCount,
                    status: $0.status.capitalized,
                    completedAt: $0.completedAt,
                    files: $0.files.map {
                        MobileCheckpointFile(path: $0.path, additions: $0.additions, deletions: $0.deletions)
                    }
                )
            },
            sessionStatus: dto.thread.session?.status.capitalized ?? "Idle",
            activeTurnID: dto.thread.session?.activeTurnId
        )
    }

    func applyShellStream(_ stream: MobileStreamMessage, to state: MobileShellState) throws -> MobileShellState {
        switch stream.payload.kind {
        case "snapshot":
            return try shellState(from: stream)
        case "project-upserted":
            guard let project = stream.payload.project else {
                throw MobileSyncError.unexpectedMessage("Expected project-upserted project.")
            }
            let dto = try MobileProjectDTO(project)
            var projects = state.projects.filter { $0.id != dto.id }
            projects.append(MobileProject(id: dto.id, title: dto.title, workspaceRoot: dto.workspaceRoot))
            return MobileShellState(
                snapshotSequence: stream.payload.sequence ?? state.snapshotSequence,
                projects: projects.sorted { $0.title < $1.title },
                threads: state.threads
            )
        case "project-removed":
            guard let projectID = stream.payload.projectId else {
                throw MobileSyncError.unexpectedMessage("Expected project-removed projectId.")
            }
            return MobileShellState(
                snapshotSequence: stream.payload.sequence ?? state.snapshotSequence,
                projects: state.projects.filter { $0.id != projectID },
                threads: state.threads.filter { $0.projectID != projectID }
            )
        case "thread-upserted":
            guard let thread = stream.payload.thread else {
                throw MobileSyncError.unexpectedMessage("Expected thread-upserted thread.")
            }
            let dto = try MobileThreadDTO(thread)
            var threads = state.threads.filter { $0.id != dto.id }
            threads.append(
                MobileThread(
                    id: dto.id,
                    projectID: dto.projectId,
                    title: dto.title,
                    status: threadStatus(dto),
                    latestSummary: latestSummary(dto)
                )
            )
            return MobileShellState(
                snapshotSequence: stream.payload.sequence ?? state.snapshotSequence,
                projects: state.projects,
                threads: threads.sorted { $0.title < $1.title }
            )
        case "thread-removed":
            guard let threadID = stream.payload.threadId else {
                throw MobileSyncError.unexpectedMessage("Expected thread-removed threadId.")
            }
            return MobileShellState(
                snapshotSequence: stream.payload.sequence ?? state.snapshotSequence,
                projects: state.projects,
                threads: state.threads.filter { $0.id != threadID }
            )
        default:
            return state
        }
    }

    func applyThreadStream(_ stream: MobileStreamMessage, to detail: MobileThreadDetail) throws -> MobileThreadDetail {
        if stream.payload.kind == "snapshot" {
            return try threadDetail(from: stream)
        }
        guard stream.payload.kind == "event", let event = stream.payload.event else {
            return detail
        }
        return try applyThreadEvent(event, to: detail)
    }

    func applyReplayEvent(_ event: JSONValue, to detail: MobileThreadDetail?) throws -> MobileThreadDetail? {
        guard let detail else {
            return nil
        }
        return try applyThreadEvent(event, to: detail)
    }

    private func applyThreadEvent(_ event: JSONValue, to detail: MobileThreadDetail) throws -> MobileThreadDetail {
        let object = try event.requiredObject("thread event")
        let sequence = try object.requiredInt("sequence")
        let type = try object.requiredString("type")
        let payload = try object.requiredObject("payload")
        guard try payload.requiredString("threadId") == detail.threadID else {
            return detail
        }

        var next = detail
        next.snapshotSequence = max(next.snapshotSequence, sequence)
        switch type {
        case "thread.message-sent":
            let message = try MobileChatMessageDTO(payload)
            if let index = next.messages.firstIndex(where: { $0.id == message.id }) {
                next.messages[index].text = message.text
            } else {
                next.messages.append(
                    MobileChatMessage(
                        id: message.id,
                        role: message.role,
                        text: message.text,
                        streaming: message.streaming,
                        createdAt: message.createdAt
                    )
                )
            }
        case "thread.activity-appended":
            let activity = try MobileThreadActivityDTO(try payload.requiredObject("activity"))
            if !next.activities.contains(where: { $0.id == activity.id }) {
                next.activities.append(
                    MobileThreadActivity(
                        id: activity.id,
                        tone: activity.tone,
                        kind: activity.kind,
                        summary: activity.summary,
                        createdAt: activity.createdAt,
                        requestID: activity.requestID,
                        interactionKind: activity.interactionKind
                    )
                )
            }
        case "thread.session-set":
            let session = try MobileThreadDTO.Session(try payload.requiredObject("session"))
            next.sessionStatus = session.status.capitalized
            next.activeTurnID = session.activeTurnId
        case "thread.proposed-plan-upserted":
            let plan = try MobileProposedPlanDTO(try payload.requiredObject("proposedPlan"))
            next.proposedPlans.removeAll { $0.id == plan.id }
            next.proposedPlans.append(
                MobileProposedPlan(
                    id: plan.id,
                    turnID: plan.turnID,
                    markdown: plan.markdown,
                    implementedAt: plan.implementedAt,
                    createdAt: plan.createdAt
                )
            )
        case "thread.turn-diff-completed":
            let checkpoint = try MobileCheckpointSummaryDTO(payload)
            next.checkpoints.removeAll { $0.turnID == checkpoint.turnID && $0.turnCount == checkpoint.turnCount }
            next.checkpoints.append(
                MobileCheckpointSummary(
                    id: "\(checkpoint.turnID):\(checkpoint.turnCount)",
                    turnID: checkpoint.turnID,
                    turnCount: checkpoint.turnCount,
                    status: checkpoint.status.capitalized,
                    completedAt: checkpoint.completedAt,
                    files: checkpoint.files.map {
                        MobileCheckpointFile(path: $0.path, additions: $0.additions, deletions: $0.deletions)
                    }
                )
            )
        default:
            break
        }
        next.timelineItems = makeTimelineItems(next)
        return next
    }

    private func makeThreadDetail(
        threadID: MobileThread.ID,
        title: String,
        snapshotSequence: Int,
        messages: [MobileChatMessage],
        activities: [MobileThreadActivity],
        proposedPlans: [MobileProposedPlan],
        checkpoints: [MobileCheckpointSummary],
        sessionStatus: String,
        activeTurnID: String?
    ) -> MobileThreadDetail {
        var detail = MobileThreadDetail(
            threadID: threadID,
            title: title,
            snapshotSequence: snapshotSequence,
            messages: messages,
            activities: activities,
            proposedPlans: proposedPlans,
            checkpoints: checkpoints,
            timelineItems: [],
            sessionStatus: sessionStatus,
            activeTurnID: activeTurnID
        )
        detail.timelineItems = makeTimelineItems(detail)
        return detail
    }

    private func makeTimelineItems(_ detail: MobileThreadDetail) -> [MobileTimelineItem] {
        (
            detail.messages.map(MobileTimelineItem.message)
                + detail.activities.map(MobileTimelineItem.activity)
                + detail.proposedPlans.map(MobileTimelineItem.plan)
                + detail.checkpoints.map(MobileTimelineItem.checkpoint)
        )
        .sorted { lhs, rhs in
            if lhs.createdAt == rhs.createdAt {
                return lhs.id < rhs.id
            }
            return lhs.createdAt < rhs.createdAt
        }
    }

    private func threadStatus(_ thread: MobileThreadDTO) -> String {
        if thread.hasPendingApprovals {
            return "Approval"
        }
        if thread.hasPendingUserInput {
            return "Input"
        }
        if thread.hasActionableProposedPlan {
            return "Plan"
        }
        if let latestTurn = thread.latestTurn {
            return latestTurn.state.capitalized
        }
        return thread.session?.status.capitalized ?? "Idle"
    }

    private func latestSummary(_ thread: MobileThreadDTO) -> String {
        if let lastError = thread.session?.lastError {
            return lastError
        }
        if thread.hasPendingApprovals {
            return "Waiting for approval."
        }
        if thread.hasPendingUserInput {
            return "Waiting for user input."
        }
        if thread.hasActionableProposedPlan {
            return "Plan ready for review."
        }
        return "No recent activity."
    }
}

extension MobileThreadDetailSnapshotDTO {
    init(_ value: JSONValue) throws {
        let object = try value.requiredObject("thread detail snapshot")
        snapshotSequence = try object.requiredInt("snapshotSequence")
        thread = try MobileThreadDetailDTO(try object.requiredObject("thread"))
    }
}

extension MobileThreadDetailDTO {
    init(_ object: [String: JSONValue]) throws {
        id = try object.requiredString("id")
        title = try object.requiredString("title")
        messages = try object.requiredArray("messages").map(MobileChatMessageDTO.init)
        activities = try object.requiredArray("activities").map(MobileThreadActivityDTO.init)
        proposedPlans = try object.optionalArray("proposedPlans").map(MobileProposedPlanDTO.init)
        checkpoints = try object.optionalArray("checkpoints").map(MobileCheckpointSummaryDTO.init)
        session = try object.optionalObject("session").map(MobileThreadDTO.Session.init)
    }
}

extension MobileProposedPlanDTO {
    init(_ value: JSONValue) throws {
        try self.init(value.requiredObject("proposed plan"))
    }

    init(_ object: [String: JSONValue]) throws {
        id = try object.requiredString("id")
        turnID = try object.optionalString("turnId")
        markdown = try object.requiredString("planMarkdown")
        implementedAt = try object.optionalString("implementedAt")
        createdAt = try object.requiredString("createdAt")
    }
}

extension MobileCheckpointSummaryDTO {
    init(_ value: JSONValue) throws {
        try self.init(value.requiredObject("checkpoint"))
    }

    init(_ object: [String: JSONValue]) throws {
        turnID = try object.requiredString("turnId")
        turnCount = try object.requiredInt("checkpointTurnCount")
        status = try object.requiredString("status")
        completedAt = try object.requiredString("completedAt")
        files = try object.requiredArray("files").map(MobileCheckpointFileDTO.init)
    }
}

extension MobileCheckpointFileDTO {
    init(_ value: JSONValue) throws {
        let object = try value.requiredObject("checkpoint file")
        path = try object.requiredString("path")
        additions = try object.requiredInt("additions")
        deletions = try object.requiredInt("deletions")
    }
}

extension MobileChatMessageDTO {
    init(_ value: JSONValue) throws {
        try self.init(value.requiredObject("message"))
    }

    init(_ object: [String: JSONValue]) throws {
        id = try object.requiredString(primaryKey: "id", alternateKey: "messageId")
        role = try object.requiredString("role")
        text = try object.requiredString("text")
        streaming = try object.requiredBool("streaming")
        createdAt = try object.requiredString("createdAt")
    }
}

extension MobileThreadActivityDTO {
    init(_ value: JSONValue) throws {
        try self.init(value.requiredObject("activity"))
    }

    init(_ object: [String: JSONValue]) throws {
        id = try object.requiredString("id")
        tone = try object.requiredString("tone")
        kind = try object.requiredString("kind")
        summary = try object.requiredString("summary")
        createdAt = try object.requiredString("createdAt")
        requestID = try object.optionalObject("payload")?.optionalString("requestId")
            ?? object.optionalString("requestId")
        interactionKind = try Self.interactionKind(tone: tone, kind: kind, object: object)
    }

    private static func interactionKind(
        tone: String,
        kind: String,
        object: [String: JSONValue]
    ) throws -> MobileActivityInteractionKind {
        if tone == "approval" {
            return .approvalRequest
        }
        if try object.optionalObject("payload")?.optionalString("interactionKind") == "user-input"
            || object.optionalString("interactionKind") == "user-input"
            || kind == "user-input"
            || kind == "user-input-request"
        {
            return .userInputRequest
        }
        return .generic
    }
}

private extension MobileShellSnapshotDTO {
    init(_ value: JSONValue) throws {
        let object = try value.requiredObject("shell snapshot")
        snapshotSequence = try object.requiredInt("snapshotSequence")
        projects = try object.requiredArray("projects").map(MobileProjectDTO.init)
        threads = try object.requiredArray("threads").map(MobileThreadDTO.init)
        updatedAt = try object.requiredString("updatedAt")
    }
}

private extension MobileProjectDTO {
    init(_ value: JSONValue) throws {
        let object = try value.requiredObject("project")
        id = try object.requiredString("id")
        title = try object.requiredString("title")
        workspaceRoot = try object.requiredString("workspaceRoot")
    }
}

private extension MobileThreadDTO {
    init(_ value: JSONValue) throws {
        let object = try value.requiredObject("thread")
        id = try object.requiredString("id")
        projectId = try object.requiredString("projectId")
        title = try object.requiredString("title")
        latestTurn = try object.optionalObject("latestTurn").map(LatestTurn.init)
        session = try object.optionalObject("session").map(Session.init)
        hasPendingApprovals = try object.requiredBool("hasPendingApprovals")
        hasPendingUserInput = try object.requiredBool("hasPendingUserInput")
        hasActionableProposedPlan = try object.requiredBool("hasActionableProposedPlan")
    }
}

private extension MobileThreadDTO.LatestTurn {
    init(_ object: [String: JSONValue]) throws {
        state = try object.requiredString("state")
    }
}

private extension MobileThreadDTO.Session {
    init(_ object: [String: JSONValue]) throws {
        status = try object.requiredString("status")
        activeTurnId = try object.optionalString("activeTurnId")
        lastError = try object.optionalString("lastError")
    }
}
