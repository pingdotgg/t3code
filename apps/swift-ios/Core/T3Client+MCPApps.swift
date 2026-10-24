import Foundation

extension T3Client {
    /// Item identity always comes from the native transcript, never from app JavaScript.
    func mcpAppRequest(operation: FeatureMCPOperation, sourceThreadID: String, itemID: String,
                       conversationThreadID: String, payload: JSONValue) async throws -> JSONValue {
        var fields: [String: JSONValue] = ["threadId": .string(sourceThreadID), "itemId": .string(itemID)]
        switch operation {
        case .toolInfo, .callTool:
            guard let name = payload["name"]?.stringValue else { throw RPCError.protocolViolation("Missing tool name") }
            fields["name"] = .string(name)
            if operation == .callTool { fields["arguments"] = payload["arguments"] ?? .object([:]) }
        case .readResource:
            guard let uri = payload["uri"]?.stringValue else { throw RPCError.protocolViolation("Missing resource URI") }
            fields["uri"] = .string(uri)
        case .updateModelContext:
            fields["conversationThreadId"] = .string(conversationThreadID)
            fields["content"] = payload["content"]
            fields["structuredContent"] = payload["structuredContent"]
            try await rpc.request("mcpApps.updateModelContext", payload: .object(fields))
            return .object([:])
        }
        return try await rpc.request("mcpApps.\(operation.rawValue)", payload: .object(fields), as: JSONValue.self)
    }
}
