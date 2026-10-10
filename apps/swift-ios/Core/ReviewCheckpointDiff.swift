import Foundation

public struct ReviewCheckpointDiff: Codable, Equatable, Sendable {
    public let threadId: String
    public let fromTurnCount: Int
    public let toTurnCount: Int
    public let diff: String
}

struct ReviewCheckpointDiffQuery: Sendable {
    let threadID: String
    let fromTurnCount: Int?
    let toTurnCount: Int

    init(threadID: String, fromTurnCount: Int?, toTurnCount: Int) throws {
        guard !threadID.isEmpty, toTurnCount >= 0,
              fromTurnCount.map({ $0 >= 0 && $0 <= toTurnCount }) ?? true else {
            throw RPCError.protocolViolation("The checkpoint diff range is invalid.")
        }
        self.threadID = threadID
        self.fromTurnCount = fromTurnCount
        self.toTurnCount = toTurnCount
    }

    var method: String {
        fromTurnCount == nil ? "orchestration.getFullThreadDiff" : "orchestration.getTurnDiff"
    }

    var payload: JSONValue {
        var fields: [String: JSONValue] = [
            "threadId": .string(threadID), "toTurnCount": .number(Double(toTurnCount)),
            "ignoreWhitespace": .bool(false),
        ]
        if let fromTurnCount { fields["fromTurnCount"] = .number(Double(fromTurnCount)) }
        return .object(fields)
    }

    func validate(_ result: ReviewCheckpointDiff) throws {
        guard result.threadId == threadID, result.toTurnCount == toTurnCount,
              result.fromTurnCount == (fromTurnCount ?? 0) else {
            throw RPCError.protocolViolation("The checkpoint diff belongs to another thread or range.")
        }
    }
}
