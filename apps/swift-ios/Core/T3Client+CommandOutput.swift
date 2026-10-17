import Foundation

/// The ephemeral stream is independent of persisted thread events.
public struct CommandOutputFrame: Decodable, Sendable, Equatable {
    public enum Kind: String, Decodable, Sendable { case replace, append }
    public let kind: Kind
    public let text: String
    public let truncated: Bool
    public let running: Bool
}

public extension T3Client {
    func commandOutput(threadID: String, itemID: String) async -> AsyncThrowingStream<CommandOutputFrame, Error> {
        await rpc.subscribe("orchestration.subscribeCommandOutput", payload: .object([
            "threadId": .string(threadID), "itemId": .string(itemID),
        ]), as: CommandOutputFrame.self)
    }
}
