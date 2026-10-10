import Foundation

/// Translates the native client's existing intents at the protocol boundary.
/// Keep wire shapes in sync with contracts/orchestrationV2.ts and client-runtime/operations/commands.ts.
public enum OrchestrationV2Commands {
    public enum ResponseKind: Sendable, Equatable {
        case dispatch, launch, project, attachments
    }

    public struct Request: Sendable, Equatable {
        public let method: String
        public let payload: JSONValue
        public let responseKind: ResponseKind
    }

    /// Retain a prepared plan when retrying a partially completed sequence.
    public struct Plan: Sendable, Equatable {
        public let requests: [Request]
    }

    public struct Result: Sendable, Equatable {
        /// Only dispatch replies contain a sequence. Launch and project replies do not.
        public let sequence: Int
        public let projection: JSONValue?
        public let project: JSONValue?
    }

    public enum AdapterError: Error, LocalizedError, Equatable {
        case unsupportedOperation(String)
        case missingField(String)
        case invalidField(String)
        case projectionRequired
        case projectionMismatch
        case unavailableIdentity(String)
        case attachmentsRequirePersistence
        case invalidResponse(String)

        public var errorDescription: String? {
            switch self {
            case let .unsupportedOperation(type): "V2 does not support the command \(type)."
            case let .missingField(field): "The V2 command needs \(field)."
            case let .invalidField(field): "The V2 command has an invalid \(field)."
            case .projectionRequired: "Load the V2 thread state before this action."
            case .projectionMismatch: "The V2 thread state belongs to another thread."
            case let .unavailableIdentity(identity): "The V2 thread state has no matching \(identity)."
            case .attachmentsRequirePersistence: "Persist attachments before building the V2 request plan."
            case let .invalidResponse(method): "The server returned an invalid response for \(method)."
            }
        }
    }

    /// A supplied projection must be the raw V2 projection, not the V1 display model.
    public static func requiresProjection(
        _ command: JSONValue, serverResolvedCommandContext: Bool = false
    ) -> Bool {
        switch command["type"]?.stringValue {
        case "thread.turn.start":
            if command["bootstrap"]?["createThread"] != nil { return false }
            // Mode setters can detach provider sessions even when their value
            // is unchanged. Compare the current thread before emitting them.
            return true
        case "thread.meta.update", "thread.metadata.update":
            return command["modelSelection"] != nil && !serverResolvedCommandContext
        case "thread.model-selection.set":
            return !serverResolvedCommandContext
        case "thread.turn.interrupt", "thread.session.stop", "queued-run.send-now":
            return true
        case "thread.conversation.revert", "thread.checkpoint.revert", "checkpoint.rollback":
            return !serverResolvedCommandContext || command["checkpointId"] == nil || command["scopeId"] == nil
        default:
            return false
        }
    }

    /// Builds explicit, ordered RPCs without I/O. Unknown operations fail here.
    public static func plan(
        _ command: JSONValue,
        projection: JSONValue? = nil,
        serverResolvedCommandContext: Bool = false
    ) throws -> Plan {
        var value = try object(command, field: "command")
        let type = try string(value["type"], field: "type")
        let commandID = try string(value["commandId"], field: "commandId")
        value.removeValue(forKey: "createdAt")

        if ["project.create", "project.update", "project.delete"].contains(type) {
            _ = try string(value["projectId"], field: "projectId")
            return Plan(requests: [Request(method: "projects.mutate", payload: .object(value), responseKind: .project)])
        }
        // Context transfers address two threads and have no single threadId.
        if type == "thread.fork" || type == "thread.merge_back" {
            let sourceID = try string(value["sourceThreadId"], field: "sourceThreadId")
            let targetID = try string(value["targetThreadId"], field: "targetThreadId")
            guard sourceID != targetID else { throw AdapterError.invalidField("targetThreadId") }
            if let projection, projection["thread"]?["id"]?.stringValue != sourceID {
                throw AdapterError.projectionMismatch
            }
            let point = try object(try required(value["sourcePoint"], field: "sourcePoint"), field: "sourcePoint")
            switch try string(point["type"], field: "sourcePoint.type") {
            case "run": _ = try string(point["runId"], field: "sourcePoint.runId")
            case "checkpoint": _ = try string(point["checkpointId"], field: "sourcePoint.checkpointId")
            case "latest_stable": break
            default: throw AdapterError.invalidField("sourcePoint.type")
            }
            if let title = value["title"] { _ = try string(title, field: "title") }
            value["createdBy"] = value["createdBy"] ?? .string("user")
            value["creationSource"] = value["creationSource"] ?? .string("mobile")
            return Plan(requests: [dispatch(value)])
        }
        let threadID = try string(value["threadId"], field: "threadId")
        if let projection, projection["thread"]?["id"]?.stringValue != threadID {
            throw AdapterError.projectionMismatch
        }
        if requiresProjection(command, serverResolvedCommandContext: serverResolvedCommandContext), projection == nil {
            throw AdapterError.projectionRequired
        }

        switch type {
        case "thread.create":
            value["createdBy"] = value["createdBy"] ?? .string("user")
            value["creationSource"] = value["creationSource"] ?? .string("mobile")
            return Plan(requests: [dispatch(value)])
        case "thread.turn.start":
            return try startTurn(value, projection: projection, serverResolved: serverResolvedCommandContext)
        case "thread.meta.update", "thread.metadata.update":
            return try metadataPlan(value, projection: projection, serverResolved: serverResolvedCommandContext)
        case "thread.model-selection.set":
            value["type"] = .string(try modelCommandType(value["modelSelection"], projection: projection,
                                                       serverResolved: serverResolvedCommandContext))
        case "thread.turn.interrupt":
            let state = try requireProjection(projection)
            let runID: String
            do {
                runID = try interruptRunID(value, projection: state)
            } catch AdapterError.unavailableIdentity("active run") {
                let links = try (state["thread"]?["pullRequests"] ?? .null).decode([ThreadPullRequestLink]?.self) ?? []
                let watched = links.filter(\.isWatched)
                guard !watched.isEmpty else { throw AdapterError.unavailableIdentity("active run") }
                return Plan(requests: watched.enumerated().map { index, link in
                    var unwatch = base("thread.pull-request.watch", threadID: threadID,
                        commandID: "\(commandID):unwatch:\(index)")
                    unwatch["host"] = .string(link.host)
                    unwatch["repository"] = .string(link.repository)
                    unwatch["number"] = .number(Double(link.number))
                    unwatch["watching"] = .bool(false)
                    return dispatch(unwatch)
                })
            }
            value = base("run.interrupt", threadID: threadID, commandID: commandID)
            value["runId"] = .string(runID)
            value["holdQueue"] = command["holdQueue"] ?? .bool(true)
            value["reason"] = command["reason"]
        case "thread.session.stop":
            let sessions = try array(requireProjection(projection)["providerSessions"], field: "providerSessions")
            return Plan(requests: try sessions.map { session in
                let id = try string(session["id"], field: "providerSession.id")
                var detach = base("provider-session.detach", threadID: threadID, commandID: "\(commandID):detach:\(id)")
                detach["providerSessionId"] = .string(id)
                detach["reason"] = .string("client-requested")
                return dispatch(detach)
            })
        case "thread.approval.respond", "thread.user-input.respond", "runtime-request.respond":
            value["type"] = .string("runtime-request.respond")
            _ = try string(value["requestId"], field: "requestId")
            if let attachments = value["attachmentsByQuestionId"] {
                let questions = try object(attachments, field: "attachmentsByQuestionId")
                value["attachmentsByQuestionId"] = .object(try questions.mapValues { try storedAttachments($0) })
            }
        case "thread.conversation.revert", "thread.checkpoint.revert", "checkpoint.rollback":
            return try rollbackPlan(value, projection: projection, serverResolved: serverResolvedCommandContext)
        case "queued-run.send-now":
            return try sendNowPlan(value, projection: requireProjection(projection))
        case "message.dispatch":
            value["attachments"] = try storedAttachments(value["attachments"])
            value["createdBy"] = value["createdBy"] ?? .string("user")
            value["creationSource"] = value["creationSource"] ?? .string("mobile")
            _ = try string(value["messageId"], field: "messageId")
        case "queued-run.edit":
            value.removeValue(forKey: "messageId") // Used only to persist replacement uploads.
            if let attachments = value["attachments"] { value["attachments"] = try storedAttachments(attachments) }
        default:
            guard directCommands.contains(type) else { throw AdapterError.unsupportedOperation(type) }
        }
        return Plan(requests: [dispatch(value)])
    }

    public static func fork(
        sourceThreadID: String, targetThreadID: String, runID: String, title: String? = nil,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        var fields = threadTransfer("thread.fork", sourceThreadID: sourceThreadID,
                                    targetThreadID: targetThreadID, runID: runID, commandID: commandID)
        if let title { fields["title"] = .string(title) }
        return .object(fields)
    }

    /// Transfers conversation context; the server chooses the transfer strategy.
    public static func mergeBack(
        sourceThreadID: String, targetThreadID: String, runID: String,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        .object(threadTransfer("thread.merge_back", sourceThreadID: sourceThreadID,
                               targetThreadID: targetThreadID, runID: runID, commandID: commandID))
    }

    private static func threadTransfer(
        _ type: String, sourceThreadID: String, targetThreadID: String, runID: String, commandID: String
    ) -> [String: JSONValue] {
        [
            "type": .string(type), "commandId": .string(commandID),
            "createdBy": .string("user"), "creationSource": .string("mobile"),
            "sourceThreadId": .string(sourceThreadID), "targetThreadId": .string(targetThreadID),
            "sourcePoint": .object(["type": .string("run"), "runId": .string(runID)]),
        ]
    }

    /// Convenience for T3Client: transport selection stays with the caller; errors propagate unchanged.
    public static func execute(
        _ command: JSONValue,
        projection: JSONValue? = nil,
        serverResolvedCommandContext: Bool = false,
        request: @Sendable (Request) async throws -> JSONValue
    ) async throws -> Result {
        let prepared = try await prepareAttachments(command, request: request)
        let plan = try plan(prepared, projection: projection, serverResolvedCommandContext: serverResolvedCommandContext)
        return try await execute(plan, request: request)
    }

    public static func execute(
        _ plan: Plan, request: @Sendable (Request) async throws -> JSONValue
    ) async throws -> Result {
        var sequence = 0
        var projection: JSONValue?
        var project: JSONValue?
        for step in plan.requests {
            try Task.checkCancellation()
            let response = try await request(step)
            switch step.responseKind {
            case .dispatch:
                guard let next = integer(response["sequence"]), next >= 0 else {
                    throw AdapterError.invalidResponse(step.method)
                }
                sequence = max(sequence, next)
            case .launch:
                guard let returned = response["projection"],
                      let threadID = response["threadId"]?.stringValue,
                      returned["thread"]?["id"]?.stringValue == threadID,
                      step.payload["threadId"]?.stringValue == threadID else {
                    throw AdapterError.invalidResponse(step.method)
                }
                projection = returned
            case .project:
                guard response["id"] == step.payload["projectId"] else {
                    throw AdapterError.invalidResponse(step.method)
                }
                project = response
            case .attachments:
                throw AdapterError.invalidResponse(step.method)
            }
        }
        return Result(sequence: sequence, projection: projection, project: project)
    }

    // MARK: Direct V2 intents

    public enum Delivery: String, Sendable, CaseIterable { case auto, steer, queue, restart, start }

    public static func sendTurn(
        threadID: String, text: String, runtimeMode: String, interactionMode: String,
        modelSelection: JSONValue? = nil, attachments: [JSONValue] = [], context: JSONValue? = nil,
        delivery: Delivery = .auto, commandID: String = UUID().uuidString, messageID: String = UUID().uuidString
    ) -> JSONValue {
        var message: [String: JSONValue] = ["messageId": .string(messageID), "text": .string(text),
                                           "role": .string("user"), "attachments": .array(attachments)]
        message["context"] = context
        var command = base("thread.turn.start", threadID: threadID, commandID: commandID)
        command["message"] = .object(message)
        command["runtimeMode"] = .string(runtimeMode)
        command["interactionMode"] = .string(interactionMode)
        command["modelSelection"] = modelSelection
        command["dispatchMode"] = .string(delivery.rawValue)
        return .object(command)
    }

    /// Includes null values so callers can clear worktree, PR, or limit-recovery metadata.
    public static func updateMetadata(
        threadID: String, fields: [String: JSONValue], commandID: String = UUID().uuidString
    ) throws -> JSONValue {
        guard !fields.isEmpty, Set(fields.keys).isSubset(of: metadataFields.union(["modelSelection"])) else {
            throw AdapterError.invalidField("metadata")
        }
        return .object(base("thread.metadata.update", threadID: threadID, commandID: commandID)
            .merging(fields) { _, value in value })
    }

    public static func cancelQueuedRun(threadID: String, runID: String, commandID: String = UUID().uuidString) -> JSONValue {
        runCommand("queued-run.cancel", threadID: threadID, runID: runID, commandID: commandID)
    }

    public static func reorderQueuedRun(
        threadID: String, runID: String, beforeRunID: String?, commandID: String = UUID().uuidString
    ) -> JSONValue {
        var command = base("queued-run.reorder", threadID: threadID, commandID: commandID)
        command["runId"] = .string(runID)
        command["beforeRunId"] = beforeRunID.map(JSONValue.string) ?? .null
        return .object(command)
    }

    public static func promoteQueuedRun(
        threadID: String, queuedRunID: String, targetRunID: String, commandID: String = UUID().uuidString
    ) -> JSONValue {
        var command = base("queued-message.promote-to-steer", threadID: threadID, commandID: commandID)
        command["queuedRunId"] = .string(queuedRunID)
        command["targetRunId"] = .string(targetRunID)
        return .object(command)
    }

    /// With an active run, sends a steer. While idle, moves this run first and resumes the queue.
    public static func sendQueuedRunNow(threadID: String, runID: String, commandID: String = UUID().uuidString) -> JSONValue {
        runCommand("queued-run.send-now", threadID: threadID, runID: runID, commandID: commandID)
    }

    public static func resumeQueue(threadID: String, commandID: String = UUID().uuidString) -> JSONValue {
        .object(base("queue.resume", threadID: threadID, commandID: commandID))
    }

    /// V2 holds queued work as part of Stop; there is no standalone queue.hold command.
    public static func interruptRun(
        threadID: String, runID: String, holdQueue: Bool = true, commandID: String = UUID().uuidString
    ) -> JSONValue {
        var command = base("run.interrupt", threadID: threadID, commandID: commandID)
        command["runId"] = .string(runID)
        command["holdQueue"] = .bool(holdQueue)
        return .object(command)
    }

    public static func editQueuedRun(
        threadID: String, runID: String, text: String, messageID: String? = nil,
        attachments: [JSONValue]? = nil, context: JSONValue? = nil, commandID: String = UUID().uuidString
    ) -> JSONValue {
        var command = base("queued-run.edit", threadID: threadID, commandID: commandID)
        command["runId"] = .string(runID)
        command["text"] = .string(text)
        command["messageId"] = messageID.map(JSONValue.string)
        command["attachments"] = attachments.map(JSONValue.array)
        command["context"] = context
        return .object(command)
    }

    public static func retryWorkspacePreparation(threadID: String, runID: String, commandID: String = UUID().uuidString) -> JSONValue {
        runCommand("prepared-run.retry", threadID: threadID, runID: runID, commandID: commandID)
    }

    public static func rollback(
        threadID: String, scopeID: String, checkpointID: String, restoreFiles: Bool,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        var command = base("checkpoint.rollback", threadID: threadID, commandID: commandID)
        command["scopeId"] = .string(scopeID)
        command["checkpointId"] = .string(checkpointID)
        command["restoreFiles"] = .bool(restoreFiles)
        return .object(command)
    }

    // MARK: Translation

    private static func startTurn(
        _ value: [String: JSONValue], projection: JSONValue?, serverResolved: Bool
    ) throws -> Plan {
        let commandID = try string(value["commandId"], field: "commandId")
        let threadID = try string(value["threadId"], field: "threadId")
        let message = try object(value["message"], field: "message")
        let messageID = try string(message["messageId"], field: "message.messageId")
        guard case .string = message["text"] else { throw AdapterError.missingField("message.text") }
        let attachments = try storedAttachments(message["attachments"])
        let bootstrap = value["bootstrap"]
        let create = bootstrap?["createThread"]
        let prepare = bootstrap?["prepareWorktree"]
        if create != nil || prepare != nil {
            let thread = try create ?? requireProjection(projection)["thread"]
            guard let thread else { throw AdapterError.missingField("thread") }
            var launch: [String: JSONValue] = [
                "commandId": .string(commandID), "threadId": .string(threadID),
                "creationSource": value["creationSource"] ?? .string("mobile"),
                "projectId": .string(try string(thread["projectId"], field: "projectId")),
                "title": value["titleSeed"] ?? thread["title"] ?? .null,
                "generateTitle": .bool(value["titleSeed"] != nil),
                "modelSelection": value["modelSelection"] ?? thread["modelSelection"] ?? .null,
                "runtimeMode": try required(value["runtimeMode"], field: "runtimeMode"),
                "interactionMode": try required(value["interactionMode"], field: "interactionMode"),
                "workspaceStrategy": try workspaceStrategy(thread: thread, preparation: prepare),
            ]
            if create == nil { launch["reuseExistingThread"] = .bool(true) }
            var initial: [String: JSONValue] = ["messageId": .string(messageID), "text": message["text"]!, "attachments": attachments]
            initial["context"] = message["context"]
            launch["initialMessage"] = .object(initial)
            return Plan(requests: [Request(method: "orchestration.launchThread", payload: .object(launch), responseKind: .launch)])
        }

        let delivery = try deliveryMode(value["dispatchMode"])
        var command = base("message.dispatch", threadID: threadID, commandID: commandID)
        command["createdBy"] = value["createdBy"] ?? .string("user")
        command["creationSource"] = value["creationSource"] ?? .string("mobile")
        command["messageId"] = .string(messageID)
        command["text"] = message["text"]
        command["context"] = message["context"]
        command["attachments"] = attachments
        command["modelSelection"] = value["modelSelection"]
        command["sourcePlanRef"] = value["sourcePlanRef"] ?? value["sourceProposedPlan"]
        for field in ["manualContinuationOfRunId", "restartContinuationOfRunId", "usageLimitContinuationOfRunId", "usageLimitRecoveryRequestId"] {
            command[field] = value[field]
        }
        if serverResolved || projection?["messages"] == .array([]) { command["titleSeed"] = value["titleSeed"] }
        if delivery == .start {
            command["dispatchMode"] = .object(["type": .string("start_immediately")])
        } else if serverResolved {
            command["dispatchMode"] = .object(["type": .string(delivery == .queue ? "queue_after_active" : "start_immediately")])
            if delivery != .queue { command["deliveryIntent"] = .string(delivery.rawValue) }
        } else {
            command["dispatchMode"] = try resolvedDispatchMode(delivery, projection: requireProjection(projection))
        }

        // V1 sends these settings on turn.start. V2 message.dispatch reads them from the thread.
        // Always use the same suffixes, even when a replay sees settings already applied.
        var requests: [Request] = []
        for (field, type, suffix) in [("runtimeMode", "thread.runtime-mode.set", "runtime-mode"),
                                      ("interactionMode", "thread.interaction-mode.set", "interaction-mode")] {
            let requested = try required(value[field], field: field)
            if projection?["thread"]?[field] == requested { continue }
            var settings = base(type, threadID: threadID, commandID: "\(commandID):\(suffix)")
            settings[field] = requested
            requests.append(dispatch(settings))
        }
        requests.append(dispatch(command))
        return Plan(requests: requests)
    }

    private static func workspaceStrategy(thread: JSONValue, preparation: JSONValue?) throws -> JSONValue {
        var result: [String: JSONValue]
        if let preparation {
            result = ["type": .string("worktree"), "baseRef": .string(try string(preparation["baseBranch"], field: "baseBranch"))]
            result["branch"] = preparation["branch"]
            result["startFromOrigin"] = preparation["startFromOrigin"]
        } else if let path = thread["worktreePath"]?.stringValue {
            result = ["type": .string("existing_worktree"), "worktreePath": .string(path)]
            if let branch = thread["branch"]?.stringValue { result["branch"] = .string(branch) }
        } else {
            result = ["type": .string("root")]
            if let branch = thread["branch"]?.stringValue { result["branch"] = .string(branch) }
        }
        return .object(result)
    }

    private static func metadataPlan(
        _ value: [String: JSONValue], projection: JSONValue?, serverResolved: Bool
    ) throws -> Plan {
        let commandID = try string(value["commandId"], field: "commandId")
        let threadID = try string(value["threadId"], field: "threadId")
        let fields = value.filter { metadataFields.contains($0.key) }
        guard Set(value.keys).isSubset(of: metadataFields.union(["type", "commandId", "threadId", "modelSelection"])) else {
            throw AdapterError.invalidField("metadata")
        }
        var requests: [Request] = []
        if !fields.isEmpty {
            requests.append(dispatch(base("thread.metadata.update", threadID: threadID, commandID: commandID)
                .merging(fields) { _, value in value }))
        }
        if let selection = value["modelSelection"] {
            let type = try modelCommandType(selection, projection: projection, serverResolved: serverResolved)
            var model = base(type, threadID: threadID, commandID: fields.isEmpty ? commandID : "\(commandID):model-selection")
            model["modelSelection"] = selection
            requests.append(dispatch(model))
        }
        guard !requests.isEmpty else { throw AdapterError.invalidField("metadata") }
        return Plan(requests: requests)
    }

    private static func modelCommandType(_ selection: JSONValue?, projection: JSONValue?, serverResolved: Bool) throws -> String {
        let instanceID = try string(selection?["instanceId"], field: "modelSelection.instanceId")
        if serverResolved { return "thread.model-selection.set" }
        let current = try string(requireProjection(projection)["thread"]?["providerInstanceId"], field: "thread.providerInstanceId")
        return current == instanceID ? "thread.model-selection.set" : "provider.switch"
    }

    private static func resolvedDispatchMode(_ delivery: Delivery, projection: JSONValue) throws -> JSONValue {
        guard let active = activeRun(projection) else { return .object(["type": .string("start_immediately")]) }
        let runID = try string(active["id"], field: "activeRun.id")
        let providerThread = values(projection["providerThreads"]).first { $0["id"] == active["providerThreadId"] }
        let sessionID = providerThread?["providerSessionId"]?.stringValue
        let session = values(projection["providerSessions"]).first { sessionID != nil && $0["id"]?.stringValue == sessionID }
        let capabilities = session?["capabilities"]?["turns"]
        let mode: String
        switch delivery {
        case .steer: mode = "steer_active"
        case .restart: mode = "restart_active"
        case .queue: mode = "queue_after_active"
        case .start: mode = "start_immediately"
        case .auto:
            if capabilities?["supportsActiveSteering"]?.boolValue == true { mode = "steer_active" }
            else if capabilities?["supportsQueuedMessages"]?.boolValue == true { mode = "queue_after_active" }
            else if capabilities?["supportsSteeringByInterruptRestart"]?.boolValue == true { mode = "restart_active" }
            else { mode = "queue_after_active" }
        }
        var result: [String: JSONValue] = ["type": .string(mode)]
        if mode == "steer_active" || mode == "restart_active" { result["targetRunId"] = .string(runID) }
        return .object(result)
    }

    private static func interruptRunID(_ value: [String: JSONValue], projection: JSONValue) throws -> String {
        let runs = values(projection["runs"]).sorted { ($0["ordinal"]?.v2Int ?? 0) < ($1["ordinal"]?.v2Int ?? 0) }
        if let explicit = value["runId"]?.stringValue ?? value["turnId"]?.stringValue {
            if runs.contains(where: { $0["id"]?.stringValue == explicit }) { return explicit }
            // A V1-shaped display turn may name the provider turn. Resolve through its attempt.
            let turns = values(projection["providerTurns"]).filter {
                $0["id"]?.stringValue == explicit || $0["nativeTurnRef"]?["nativeId"]?.stringValue == explicit
            }
            let ids = Set(turns.compactMap { turn -> String? in
                guard let attemptID = turn["runAttemptId"]?.stringValue else { return nil }
                return values(projection["attempts"]).first { $0["id"]?.stringValue == attemptID }?["runId"]?.stringValue
            })
            guard ids.count == 1, let id = ids.first, runs.contains(where: { $0["id"]?.stringValue == id }) else {
                throw AdapterError.unavailableIdentity("run for turn \(explicit)")
            }
            return id
        }
        if let active = runs.last(where: { ["preparing", "starting", "running", "waiting"].contains($0["status"]?.stringValue ?? "") }) {
            return try string(active["id"], field: "activeRun.id")
        }
        if let latest = runs.last, hasPendingBackgroundWork(projection, latestRun: latest) {
            return try string(latest["id"], field: "latestRun.id")
        }
        throw AdapterError.unavailableIdentity("active run")
    }

    private static func rollbackPlan(
        _ value: [String: JSONValue], projection: JSONValue?, serverResolved: Bool
    ) throws -> Plan {
        let checkpointID: String
        let scopeID: String
        if let id = value["checkpointId"]?.stringValue, let scope = value["scopeId"]?.stringValue, serverResolved {
            checkpointID = id
            scopeID = scope
        } else {
            let state = try requireProjection(projection)
            let checkpoints = values(state["checkpoints"])
            let selected: JSONValue?
            if value["checkpointId"] != nil || value["scopeId"] != nil {
                guard let id = value["checkpointId"]?.stringValue, let scope = value["scopeId"]?.stringValue else {
                    throw AdapterError.missingField("checkpointId and scopeId")
                }
                selected = checkpoints.first { $0["id"]?.stringValue == id && $0["scopeId"]?.stringValue == scope }
            } else if let count = integer(value["turnCount"]), count >= 0 {
                selected = precedingCheckpoint(upTo: count, projection: state)
            } else {
                throw AdapterError.missingField("checkpoint identity or turnCount")
            }
            guard let selected, selected["status"]?.stringValue == "ready" else {
                throw AdapterError.unavailableIdentity("ready checkpoint")
            }
            try validateRollbackCheckpoint(selected, projection: state)
            checkpointID = try string(selected["id"], field: "checkpoint.id")
            scopeID = try string(selected["scopeId"], field: "checkpoint.scopeId")
        }
        var result = base("checkpoint.rollback", threadID: try string(value["threadId"], field: "threadId"),
                          commandID: try string(value["commandId"], field: "commandId"))
        result["checkpointId"] = .string(checkpointID)
        result["scopeId"] = .string(scopeID)
        result["restoreFiles"] = value["type"]?.stringValue == "thread.conversation.revert" ? .bool(false) : value["restoreFiles"]
        return Plan(requests: [dispatch(result)])
    }

    public struct ConversationRollbackTarget: Equatable, Sendable {
        public let runID: String
        public let checkpointID: String
        public let scopeID: String
        public let appRunOrdinal: Int
    }

    public struct RollbackError: LocalizedError, Equatable {
        public let message: String
        public var errorDescription: String? { message }
    }

    /// Resolve against a full projection. Run ordinals can have gaps from cancelled
    /// or promoted queued runs, so subtraction cannot identify a checkpoint.
    public static func conversationRollbackTarget(
        beforeRunID runID: String, projection: JSONValue
    ) throws -> ConversationRollbackTarget {
        let providerThreadID = try rollbackProviderThreadID(projection)
        guard let run = values(projection["runs"]).first(where: { $0["id"]?.stringValue == runID }),
              ["completed", "interrupted", "failed", "cancelled"].contains(run["status"]?.stringValue ?? ""),
              let ordinal = integer(run["ordinal"]), ordinal > 0 else {
            throw RollbackError(message: "This message has no finished local run to rewind.")
        }
        guard run["providerThreadId"]?.stringValue == providerThreadID else {
            throw RollbackError(message: "Cannot rewind across a provider handoff.")
        }
        if let checkpointID = run["checkpointId"]?.stringValue {
            guard values(projection["checkpoints"]).contains(where: {
                $0["id"]?.stringValue == checkpointID && $0["status"]?.stringValue == "ready"
            }) else {
                throw RollbackError(message: "This turn's checkpoint is not ready. Wait for it to finish before rewinding.")
            }
        }
        guard let checkpoint = precedingCheckpoint(upTo: ordinal - 1, projection: projection) else {
            throw RollbackError(message: "No earlier checkpoint is available for this message.")
        }
        try validateRollbackCheckpoint(checkpoint, projection: projection)
        return ConversationRollbackTarget(
            runID: runID, checkpointID: try string(checkpoint["id"], field: "checkpoint.id"),
            scopeID: try string(checkpoint["scopeId"], field: "checkpoint.scopeId"),
            appRunOrdinal: integer(checkpoint["appRunOrdinal"]) ?? 0
        )
    }

    private static func precedingCheckpoint(upTo ordinal: Int, projection: JSONValue) -> JSONValue? {
        let runOrdinals = Set(values(projection["runs"]).compactMap { run -> Int? in
            run["status"]?.stringValue == "rolled_back" ? nil : integer(run["ordinal"])
        })
        let scopeIDs = Set(values(projection["checkpointScopes"]).compactMap { scope -> String? in
            scope["advancesAppRunCount"]?.boolValue == true ? scope["id"]?.stringValue : nil
        })
        return values(projection["checkpoints"]).filter { checkpoint in
            guard let scopeID = checkpoint["scopeId"]?.stringValue, scopeIDs.contains(scopeID) else { return false }
            if let count = integer(checkpoint["appRunOrdinal"]) {
                return count > 0 && count <= ordinal && runOrdinals.contains(count)
            }
            return integer(checkpoint["ordinalWithinScope"]) == 0 && checkpoint["appRunOrdinal"] == .null
        }.max { (integer($0["appRunOrdinal"]) ?? 0) < (integer($1["appRunOrdinal"]) ?? 0) }
    }

    private static func rollbackProviderThreadID(_ projection: JSONValue) throws -> String {
        let thread = projection["thread"]
        guard !(thread?["creationSource"]?.stringValue == "provider"
                && thread?["lineage"]?["relationshipToParent"]?.stringValue == "subagent") else {
            throw RollbackError(message: "This subagent conversation is read-only.")
        }
        let runs = values(projection["runs"])
        let latest = runs.filter { $0["status"]?.stringValue != "rolled_back" }
            .max { (integer($0["ordinal"]) ?? 0) < (integer($1["ordinal"]) ?? 0) }
        guard runs.allSatisfy({ ["completed", "interrupted", "failed", "cancelled", "rolled_back"]
            .contains($0["status"]?.stringValue ?? "") }),
              latest.map({ !hasPendingBackgroundWork(projection, latestRun: $0) }) ?? true else {
            throw RollbackError(message: "Wait for this thread's work to finish before rewinding.")
        }
        guard let id = thread?["activeProviderThreadId"]?.stringValue,
              let provider = values(projection["providerThreads"]).first(where: { $0["id"]?.stringValue == id }),
              provider["providerSessionId"]?.stringValue != nil else {
            throw RollbackError(message: "No active provider session is available for rewind.")
        }
        if let instanceID = provider["providerInstanceId"]?.stringValue,
           instanceID != thread?["modelSelection"]?["instanceId"]?.stringValue {
            throw RollbackError(message: "Cannot rewind across a provider handoff.")
        }
        return id
    }

    private static func validateRollbackCheckpoint(_ checkpoint: JSONValue, projection: JSONValue) throws {
        let providerThreadID = try rollbackProviderThreadID(projection)
        guard checkpoint["status"]?.stringValue == "ready" else {
            throw RollbackError(message: "The earlier checkpoint is not ready. Wait for it to finish before rewinding.")
        }
        guard let scope = values(projection["checkpointScopes"]).first(where: { $0["id"] == checkpoint["scopeId"] }) else {
            throw AdapterError.unavailableIdentity("checkpoint scope")
        }
        let ordinal = integer(checkpoint["appRunOrdinal"]) ?? 0
        if ordinal == 0 {
            guard scope["providerThreadId"]?.stringValue == providerThreadID else {
                throw RollbackError(message: "Cannot rewind across a provider handoff.")
            }
            return
        }
        guard let run = values(projection["runs"]).first(where: { integer($0["ordinal"]) == ordinal }),
              run["status"]?.stringValue != "rolled_back",
              let attemptID = run["activeAttemptId"]?.stringValue else {
            throw RollbackError(message: "The earlier checkpoint's provider turn is unavailable.")
        }
        let attempt = values(projection["attempts"]).first { $0["id"]?.stringValue == attemptID }
        guard let turn = values(projection["providerTurns"]).first(where: {
            $0["runAttemptId"]?.stringValue == attemptID || $0["id"]?.stringValue == attempt?["providerTurnId"]?.stringValue
        }) else {
            throw RollbackError(message: "The earlier checkpoint's provider turn is unavailable.")
        }
        guard turn["providerThreadId"]?.stringValue == providerThreadID else {
            throw RollbackError(message: "Cannot rewind across a provider handoff.")
        }
    }

    private static func sendNowPlan(_ value: [String: JSONValue], projection: JSONValue) throws -> Plan {
        let threadID = try string(value["threadId"], field: "threadId")
        let commandID = try string(value["commandId"], field: "commandId")
        let runID = try string(value["runId"], field: "runId")
        let automaticIDs = Set(values(projection["messages"]).filter {
            $0["notification"] != nil || $0["delegatedCompletion"] != nil
        }.compactMap { $0["id"]?.stringValue })
        let queued = values(projection["runs"]).filter {
            $0["status"]?.stringValue == "queued" && !automaticIDs.contains($0["userMessageId"]?.stringValue ?? "")
        }.sorted { left, right in
            let l = integer(left["queuePosition"]) ?? integer(left["ordinal"]) ?? 0
            let r = integer(right["queuePosition"]) ?? integer(right["ordinal"]) ?? 0
            return l == r ? (integer(left["ordinal"]) ?? 0) < (integer(right["ordinal"]) ?? 0) : l < r
        }
        guard queued.contains(where: { $0["id"]?.stringValue == runID }) else {
            throw AdapterError.unavailableIdentity("queued run \(runID)")
        }
        if let active = activeRun(projection) {
            return try plan(promoteQueuedRun(threadID: threadID, queuedRunID: runID,
                targetRunID: string(active["id"], field: "activeRun.id"), commandID: commandID))
        }
        let firstOther = queued.first { $0["id"]?.stringValue != runID }?["id"]?.stringValue
        let reorder = try plan(reorderQueuedRun(threadID: threadID, runID: runID, beforeRunID: firstOther,
                                               commandID: "\(commandID):reorder"))
        let resume = try plan(resumeQueue(threadID: threadID, commandID: "\(commandID):resume"))
        return Plan(requests: reorder.requests + resume.requests)
    }

    // MARK: Attachments

    /// Persists inline image uploads and rebinds context IDs. Signed HTTP uploads already have the stored shape.
    public static func prepareAttachments(
        _ command: JSONValue, request: @Sendable (Request) async throws -> JSONValue
    ) async throws -> JSONValue {
        var result = try object(command, field: "command")
        let type = try string(result["type"], field: "type")
        if type == "thread.turn.start" {
            var message = try object(result["message"], field: "message")
            message = try await persistMessageAttachments(message, threadID: string(result["threadId"], field: "threadId"), request: request)
            result["message"] = .object(message)
        } else if type == "message.dispatch" || type == "queued-run.edit" {
            if result["attachments"] != nil {
                result = try await persistMessageAttachments(result, threadID: string(result["threadId"], field: "threadId"), request: request)
            }
        } else if ["thread.user-input.respond", "runtime-request.respond"].contains(type), let attachments = result["attachmentsByQuestionId"] {
            let threadID = try string(result["threadId"], field: "threadId")
            let commandID = try string(result["commandId"], field: "commandId")
            var questions = try object(attachments, field: "attachmentsByQuestionId")
            for questionID in questions.keys.sorted() {
                let message: [String: JSONValue] = [
                    "messageId": .string("\(commandID):answer:\(questionID)"),
                    "attachments": questions[questionID]!,
                ]
                questions[questionID] = try await persistMessageAttachments(message, threadID: threadID, request: request)["attachments"]
            }
            result["attachmentsByQuestionId"] = .object(questions)
        }
        return .object(result)
    }

    private static func persistMessageAttachments(
        _ message: [String: JSONValue], threadID: String,
        request: @Sendable (Request) async throws -> JSONValue
    ) async throws -> [String: JSONValue] {
        let before = try array(message["attachments"], field: "attachments")
        let uploads = before.filter { $0["dataUrl"] != nil }
        var result = message
        guard !uploads.isEmpty else {
            result["attachments"] = try storedAttachments(.array(before))
            return result
        }
        let messageID = try string(message["messageId"], field: "messageId for attachment persistence")
        guard uploads.allSatisfy({ $0["type"]?.stringValue == "image" }) else {
            throw AdapterError.invalidField("inline attachment type; files require a signed HTTP upload")
        }
        let step = Request(method: "assets.persistChatAttachments", payload: .object([
            "threadId": .string(threadID), "messageId": .string(messageID), "attachments": .array(uploads),
        ]), responseKind: .attachments)
        let response = try await request(step)
        let persisted = try array(response["attachments"], field: "persisted attachments")
        guard persisted.count == uploads.count else { throw AdapterError.invalidResponse(step.method) }
        var index = 0
        let after = before.map { attachment -> JSONValue in
            guard attachment["dataUrl"] != nil else { return attachment }
            defer { index += 1 }
            return persisted[index]
        }
        result["attachments"] = try storedAttachments(.array(after))
        if let context = message["context"] {
            var bindings: [String: String] = [:]
            for (original, stored) in zip(before, after) {
                if let oldID = original["id"]?.stringValue, let newID = stored["id"]?.stringValue { bindings[oldID] = newID }
            }
            var contextObject = try object(context, field: "context")
            contextObject["records"] = .array(try array(contextObject["records"], field: "context.records").map { record in
                guard ["image", "file"].contains(record["kind"]?.stringValue ?? ""),
                      let id = record["attachmentId"]?.stringValue, let replacement = bindings[id] else { return record }
                var changed = try object(record, field: "context record")
                changed["attachmentId"] = .string(replacement)
                return .object(changed)
            })
            result["context"] = .object(contextObject)
        }
        return result
    }

    private static func storedAttachments(_ value: JSONValue?) throws -> JSONValue {
        .array(try array(value, field: "attachments").map { attachment in
            if attachment["dataUrl"] != nil { throw AdapterError.attachmentsRequirePersistence }
            for key in ["type", "id", "name", "mimeType"] { _ = try string(attachment[key], field: "attachment.\(key)") }
            guard let size = integer(attachment["sizeBytes"]), size >= 0 else { throw AdapterError.invalidField("attachment.sizeBytes") }
            let fields = try object(attachment, field: "attachment")
            return .object(fields.filter { ["type", "id", "name", "mimeType", "sizeBytes", "source"].contains($0.key) })
        })
    }

    // MARK: Projection helpers

    private static func activeRun(_ projection: JSONValue) -> JSONValue? {
        values(projection["runs"]).last { ["preparing", "starting", "running", "waiting"].contains($0["status"]?.stringValue ?? "") }
    }

    private static func hasPendingBackgroundWork(_ projection: JSONValue, latestRun: JSONValue) -> Bool {
        guard ["cancelled", "completed", "failed", "interrupted", "waiting"].contains(latestRun["status"]?.stringValue ?? "") else { return false }
        let activeThreadID = projection["thread"]?["activeProviderThreadId"]?.stringValue
        if values(projection["providerThreads"]).contains(where: { thread in
            (activeThreadID == nil || thread["id"]?.stringValue == activeThreadID)
                && values(thread["pendingBackgroundTasks"]).contains { !($0["taskId"]?.stringValue ?? "").isEmpty }
        }) { return true }
        let rolledBackIDs = Set(values(projection["runs"]).filter { $0["status"]?.stringValue == "rolled_back" }.compactMap { $0["id"]?.stringValue })
        return values(projection["turnItems"] ?? projection["backgroundTurnItems"]).contains { item in
            ["command_execution", "dynamic_tool", "subagent"].contains(item["type"]?.stringValue ?? "")
                && ["pending", "running", "waiting"].contains(item["status"]?.stringValue ?? "")
                && !(item["type"]?.stringValue == "dynamic_tool"
                    && (item["input"]?["persistent"]?.boolValue == true || item["persistent"]?.boolValue == true))
                && !rolledBackIDs.contains(item["runId"]?.stringValue ?? "")
        }
    }

    private static let metadataFields: Set<String> = [
        "title", "regenerateTitle", "branch", "worktreePath", "expectedWorktreePath", "expectedEmpty", "limitRecovery", "linkedPullRequest",
    ]

    private static let directCommands: Set<String> = [
        "thread.archive", "thread.unarchive", "thread.delete", "thread.settle", "thread.unsettle",
        "thread.snooze", "thread.unsnooze", "thread.auto-settle.set", "thread.pin", "thread.unpin",
        "thread.pin.reorder", "thread.active.reorder", "thread.visit", "thread.mark-unread",
        "thread.runtime-mode.set", "thread.interaction-mode.set", "provider.switch", "provider-session.detach",
        "thread.user-input.dismiss", "run.interrupt", "queue.resume", "queued-run.reorder", "queued-run.cancel",
        "queued-message.promote-to-steer", "prepared-run.retry", "prepared-run.release",
        "thread.pull-request.link", "thread.pull-request.unlink", "thread.pull-request.watch",
    ]

    private static func base(_ type: String, threadID: String, commandID: String) -> [String: JSONValue] {
        ["type": .string(type), "threadId": .string(threadID), "commandId": .string(commandID)]
    }

    private static func runCommand(_ type: String, threadID: String, runID: String, commandID: String) -> JSONValue {
        var value = base(type, threadID: threadID, commandID: commandID)
        value["runId"] = .string(runID)
        return .object(value)
    }

    private static func dispatch(_ value: [String: JSONValue]) -> Request {
        Request(method: "orchestration.dispatchCommand", payload: .object(value), responseKind: .dispatch)
    }

    private static func deliveryMode(_ value: JSONValue?) throws -> Delivery {
        guard let value else { return .auto }
        guard let raw = value.stringValue, let delivery = Delivery(rawValue: raw) else { throw AdapterError.invalidField("dispatchMode") }
        return delivery
    }

    private static func requireProjection(_ projection: JSONValue?) throws -> JSONValue {
        guard let projection else { throw AdapterError.projectionRequired }
        return projection
    }

    private static func required(_ value: JSONValue?, field: String) throws -> JSONValue {
        guard let value, value != .null else { throw AdapterError.missingField(field) }
        return value
    }

    private static func string(_ value: JSONValue?, field: String) throws -> String {
        guard let text = value?.stringValue, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AdapterError.missingField(field)
        }
        return text
    }

    private static func object(_ value: JSONValue?, field: String) throws -> [String: JSONValue] {
        guard case let .object(result) = value else { throw AdapterError.invalidField(field) }
        return result
    }

    private static func array(_ value: JSONValue?, field: String) throws -> [JSONValue] {
        guard case let .array(result) = value else { throw AdapterError.invalidField(field) }
        return result
    }

    private static func values(_ value: JSONValue?) -> [JSONValue] {
        guard case let .array(result) = value else { return [] }
        return result
    }

    private static func integer(_ value: JSONValue?) -> Int? {
        switch value {
        case let .integer(value): Int(exactly: value)
        case let .unsignedInteger(value): Int(exactly: value)
        case let .number(value): Int(exactly: value)
        default: nil
        }
    }
}
