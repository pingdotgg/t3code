import Foundation

/// Ephemeral RPC input. Never store this in a message, draft, or command outbox.
public enum SecretRequestAnswer: Sendable {
    case save(String)
    case decline

    var payload: JSONValue? {
        switch self {
        case let .save(value):
            let secret = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !secret.isEmpty else { return nil }
            return .object(["type": .string("save"), "secret": .string(secret)])
        case .decline:
            return .object(["type": .string("decline")])
        }
    }
}

/// Only fixed server copy can cross this boundary; arbitrary failures may contain input.
enum SecretRequestFailure {
    static let generic = "Could not answer the request. Try again."
    static let messagesByReason = [
        "load_failed": "Could not load the secret request.",
        "not_found": "This secret request no longer exists.",
        "already_answered": "This secret request was already answered.",
        "agent_stopped": "The agent that asked has stopped, so this secret can't be used.",
        "store_failed": "Could not store the secret.",
        "record_failed": "Saved the secret, but could not update the request.",
    ]
    static let safeMessages = Set(messagesByReason.values).union([
        "The authenticated token is missing required scope: orchestration:operate.",
    ])

    static func message(_ error: any Error) -> String {
        if let error = error as? SecretRequestSafeError { return error.message }
        if error is EnvironmentPermissionDeniedError { return "You do not have permission to answer this request." }
        if case let RPCError.remote(message) = error, safeMessages.contains(message) { return message }
        return generic
    }
}

struct SecretRequestSafeError: LocalizedError, Sendable {
    let message: String
    init(_ error: any Error) { message = SecretRequestFailure.message(error) }
    var errorDescription: String? { message }
}

extension T3Client {
    public func answerSecretRequest(threadID: String, turnItemID: String, answer: SecretRequestAnswer) async throws {
        guard let answer = answer.payload else { return }
        do {
            try await rpc.request(RPCMethod.secretsAnswerRequest.rawValue, payload: .object([
                "threadId": .string(threadID), "turnItemId": .string(turnItemID), "answer": answer,
            ]))
        } catch {
            throw SecretRequestSafeError(error)
        }
    }
}
