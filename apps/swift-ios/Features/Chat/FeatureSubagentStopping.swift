import Foundation

@MainActor
protocol FeatureSubagentStopping: AnyObject {
    func stoppableSubagentIDs(threadID: String) async throws -> Set<String>
    func stopSubagent(threadID: String, subagentID: String) async throws
}

@MainActor
struct FeatureSubagentStopContext {
    let threadID: String
    let client: any FeatureSubagentStopping
    let canOperate: Bool
}

/// Native task evidence is absent from display rows. Read it from server controls.
enum FeatureSubagentStopPolicy {
    static func targets(projection: JSONValue, threadID: String) throws -> [String: String] {
        guard projection["thread"]?["id"]?.stringValue == threadID else {
            throw OrchestrationV2StateError.wrongThread
        }
        var targets: [String: String] = [:]
        for agent in projection["subagents"]?.v2Array ?? [] {
            guard agent["threadId"]?.stringValue == threadID,
                  agent["origin"]?.stringValue == "provider_native",
                  agent["driver"]?.stringValue == "claudeAgent",
                  ["pending", "running", "waiting"].contains(agent["status"]?.stringValue ?? ""),
                  agent["nativeTaskRef"]?["strength"]?.stringValue == "strong",
                  agent["nativeTaskRef"]?["nativeId"]?.stringValue != nil,
                  let runID = agent["runId"]?.stringValue,
                  let id = agent["id"]?.stringValue else { continue }
            targets[id] = runID
        }
        return targets
    }

    static func command(projection: JSONValue, threadID: String, subagentID: String,
                        commandID: String = UUID().uuidString) throws -> JSONValue {
        guard let runID = try targets(projection: projection, threadID: threadID)[subagentID] else {
            throw FeatureCapabilityUnavailable("This agent can no longer be stopped individually. Refresh the thread.")
        }
        return .object([
            "type": .string("subagent.stop"), "commandId": .string(commandID),
            "threadId": .string(threadID), "runId": .string(runID), "subagentId": .string(subagentID),
        ])
    }
}
