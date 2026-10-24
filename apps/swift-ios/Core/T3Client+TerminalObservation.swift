import Foundation

public extension T3Client {
    /// Reads an existing session without opening, restarting, or resizing its PTY.
    func observeTerminal(
        threadID: String,
        terminalID: String
    ) async -> AsyncThrowingStream<TerminalEvent, Error> {
        await rpc.subscribe(
            "terminal.observe",
            payload: .object([
                "threadId": .string(threadID),
                "terminalId": .string(terminalID),
            ]),
            as: TerminalEvent.self
        )
    }
}
