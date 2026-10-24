import Foundation
@testable import T3Code

/// Advertises the current protocol for mock hosts.
func v2EnvironmentDescriptorData(for environment: Environment) throws -> Data {
    let capabilities: JSONValue
    if let descriptor = environment.descriptor {
        capabilities = try .encode(descriptor.capabilities)
    } else {
        capabilities = .object(["repositoryIdentity": .bool(false)])
    }
    return try JSONEncoder.t3.encode(JSONValue.object([
        "environmentId": .string(environment.id),
        "orchestrationProtocolVersion": .number(2),
        "label": .string(environment.label),
        "platform": .object(["os": .string("darwin"), "arch": .string("arm64")]),
        "serverVersion": .string("1.0.0"),
        "capabilities": capabilities,
    ]))
}

/// Encode display-model fixtures as the V2 records served by current hosts.
func v2ShellFixture(_ snapshot: OrchestrationShellSnapshot) throws -> JSONValue {
    let threads = try snapshot.threads.map { source in
        let raw = try JSONValue.encode(source)
        let latest = raw["latestTurn"]
        let status = v2FixtureStatus(latest?["state"]?.stringValue ?? raw["session"]?["status"]?.stringValue)
        return V2Fixture.patch(try v2ThreadFixtureRecord(raw), [
            "status": .string(status), "latestRunId": latest?["turnId"] ?? .null,
            "latestRunRequestedAt": latest?["requestedAt"] ?? .null,
            "latestRunStartedAt": latest?["startedAt"] ?? .null,
            "latestRunCompletedAt": latest?["completedAt"] ?? .null,
            "activeRunId": ["running", "waiting"].contains(status) ? latest?["turnId"] ?? .null : .null,
            "activityRunStatus": ["running", "waiting"].contains(status) ? .string(status) : .null,
            "activityRunStartedAt": latest?["startedAt"] ?? .null,
            "latestVisibleMessage": .null, "itemCount": .number(0), "visibleItemCount": .number(0),
            "latestUserMessageAt": raw["latestUserMessageAt"] ?? .null,
            "hasActionableProposedPlan": raw["hasActionableProposedPlan"] ?? .bool(false),
            "pendingRuntimeRequest": source.hasPendingApprovals
                ? V2Fixture.request("approval")
                : source.hasPendingUserInput ? V2Fixture.request("question", kind: "user_input") : .null,
            "pendingBackgroundTasks": .array(source.backgroundLiveness.map { liveness in
                [.object(["taskId": .string("background"), "kind": .string(liveness == .monitoring ? "monitor" : "background_task")])]
            } ?? []),
            "lastError": raw["session"]?["lastError"] ?? .null,
        ])
    }
    return .object([
        "schemaVersion": .number(1), "snapshotSequence": .number(Double(snapshot.snapshotSequence)),
        "projects": try .encode(snapshot.projects),
        "threads": .array(threads.filter { $0["archivedAt"] == .null }),
        "archivedThreads": .array(threads.filter { $0["archivedAt"] != .null }),
    ])
}

func v2ThreadFixture(_ snapshot: OrchestrationThreadDetailSnapshot) throws -> JSONValue {
    let source = snapshot.thread
    let raw = try JSONValue.encode(source)
    let thread = try v2ThreadFixtureRecord(raw)
    var items = try source.messages.enumerated().map { index, message in
        try v2MessageFixture(message, threadID: source.id, ordinal: index)
    }
    items += try source.activities.enumerated().map { index, activity in
        try v2ActivityFixture(activity, threadID: source.id, ordinal: source.messages.count + index)
    }
    let runs: [JSONValue] = source.latestTurn.map { latest in
        [V2Fixture.patch(V2Fixture.run(latest.turnId, status: v2FixtureStatus(latest.state)), [
            "threadId": .string(source.id), "providerInstanceId": .string(source.modelSelection.instanceId),
            "modelSelection": raw["modelSelection"] ?? .null,
            "requestedAt": .string(latest.requestedAt),
            "startedAt": latest.startedAt.map(JSONValue.string) ?? .null,
            "completedAt": latest.completedAt.map(JSONValue.string) ?? .null,
            "providerThreadId": .null,
        ])]
    } ?? []
    return V2Fixture.patch(V2Fixture.snapshot(items: items, fields: [
        "thread": thread, "runs": .array(runs), "updatedAt": .string(source.updatedAt),
        "runtimeRequests": .array(source.activities.compactMap(v2RuntimeRequestFixture)),
    ]), [
        "snapshotSequence": .number(Double(snapshot.snapshotSequence)),
        "historyCursor": snapshot.page?.beforeCursor.map(JSONValue.string) ?? .null,
        "hasMoreHistory": .bool(snapshot.page?.hasMore ?? false),
    ])
}

private func v2ThreadFixtureRecord(_ raw: JSONValue) throws -> JSONValue {
    let id = raw["id"] ?? .null
    return V2Fixture.patch(V2Fixture.thread, raw.v2Object.merging([
        "providerInstanceId": raw["modelSelection"]?["instanceId"] ?? .string("codex"),
        "activeProviderThreadId": .null,
        "branch": raw["branch"] ?? .null, "worktreePath": raw["worktreePath"] ?? .null,
        "archivedAt": raw["archivedAt"] ?? .null,
        "lineage": .object(["rootThreadId": id, "parentThreadId": .null,
                            "relationshipToParent": raw["relationshipToParent"] ?? .null]),
    ], uniquingKeysWith: { _, next in next }))
}

private func v2FixtureStatus(_ status: String?) -> String {
    switch status {
    case "inProgress", "in-progress", "active", "running", "starting": "running"
    case "waiting", "waitingForInput": "waiting"
    case "completed", "complete", "ready": "completed"
    case "failed", "error": "failed"
    case "interrupted": "interrupted"
    default: "idle"
    }
}

func v2MessageFixture(_ message: OrchestrationMessage, threadID: String, ordinal: Int) throws -> JSONValue {
    V2Fixture.item(message.id, type: message.role == "user" ? "user_message" : "assistant_message", ordinal: ordinal, fields: [
        "threadId": .string(threadID), "runId": message.turnId.map(JSONValue.string) ?? .null,
        "nodeId": .null, "messageId": .string(message.id), "text": .string(message.text),
        "streaming": .bool(message.streaming), "attachments": try .encode(message.attachments ?? []),
        "context": try .encode(message.context),
        "inputIntent": .string("turn_start"), "createdBy": .string("user"), "creationSource": .string("mobile"),
        "status": .string(message.streaming ? "running" : "completed"),
        "startedAt": .string(message.createdAt), "updatedAt": .string(message.updatedAt),
        "completedAt": message.streaming ? .null : .string(message.updatedAt),
    ])
}

private func v2ActivityFixture(_ activity: OrchestrationActivity, threadID: String, ordinal: Int) throws -> JSONValue {
    if let item = activity.v2Item {
        return V2Fixture.patch(item, ["threadId": .string(threadID)])
    }
    var fields = activity.payload.v2Object
    fields["threadId"] = .string(threadID)
    fields["runId"] = .null
    fields["nodeId"] = .null
    fields["title"] = .string(activity.summary)
    fields["startedAt"] = .string(activity.createdAt)
    fields["updatedAt"] = .string(activity.createdAt)
    let type: String
    if activity.kind.hasPrefix("approval.") {
        type = "approval_request"
        fields["requestKind"] = fields["requestType"] ?? .string("command")
        fields["prompt"] = fields["detail"]
    } else if activity.kind.hasPrefix("user-input.") {
        type = "user_input_request"
        fields["questions"] = .array((fields["questions"]?.v2Array ?? []).map { question in
            V2Fixture.patch(question, ["allowCustomAnswer": question["allowCustomAnswer"] ?? .bool(true)])
        })
    } else {
        type = "dynamic_tool"
        fields["toolName"] = .string(activity.kind)
        fields["input"] = activity.payload
        fields["output"] = .null
    }
    return V2Fixture.item(activity.id, type: type, ordinal: ordinal, fields: fields)
}

func v2RuntimeRequestFixture(_ activity: OrchestrationActivity) -> JSONValue? {
    guard let id = activity.payload["requestId"]?.stringValue,
          activity.kind.hasPrefix("approval.") || activity.kind.hasPrefix("user-input.") else { return nil }
    let type = activity.payload["responseMode"]?.stringValue == "message" ? "message" : "live"
    let status = activity.v2Item?["requestStatus"]?.stringValue
        ?? (activity.kind.hasSuffix("resolved") ? "resolved" : "pending")
    return V2Fixture.patch(V2Fixture.request(id,
        kind: activity.kind.hasPrefix("approval.") ? activity.payload["requestKind"]?.stringValue ?? "command" : "user_input",
        status: status, response: type), [
            "responseCapability": activity.payload["responseCapability"] ??
                .object(type == "live" ? ["type": .string(type), "providerSessionId": .string("session")] : ["type": .string(type)]),
        ])
}

func v2FixtureThreadID(from url: URL) -> String {
    let components = url.pathComponents
    guard let index = components.firstIndex(of: "threads"), components.indices.contains(index + 1) else {
        return url.lastPathComponent
    }
    return components[index + 1]
}

func v2StreamEvent(threadID: String, type: String, payload: JSONValue, sequence: Int) -> JSONValue {
    let frame = V2Fixture.event(type, payload: payload, sequence: sequence)
    return V2Fixture.patch(frame, ["event": V2Fixture.patch(frame["event"]!, ["threadId": .string(threadID)])])
}

func v2LaunchFixture(_ input: JSONValue) -> JSONValue {
    let threadID = input["threadId"] ?? .string("thread")
    let thread = V2Fixture.patch(V2Fixture.thread, [
        "id": threadID, "projectId": input["projectId"] ?? .string("project"),
        "title": input["title"] ?? .string("New task"),
        "modelSelection": input["modelSelection"] ?? V2Fixture.thread["modelSelection"]!,
        "runtimeMode": input["runtimeMode"] ?? .string("full-access"),
        "interactionMode": input["interactionMode"] ?? .string("default"),
        "lineage": .object(["rootThreadId": threadID, "parentThreadId": .null, "relationshipToParent": .null]),
    ])
    let projection = V2Fixture.snapshot(fields: ["thread": thread])["projection"]!
    return .object(["threadId": threadID, "projection": projection, "resumed": .bool(false)])
}
