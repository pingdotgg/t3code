import Foundation

extension T3Client {
    // Preview RPCs are environment services, independent of orchestration V1/V2.
    func serverBrowserEvents() async throws -> (events: AsyncThrowingStream<ServerBrowserEvent, Error>, connectionID: UUID) {
        try await rpc.subscribeOnCurrentConnection("subscribePreviewEvents", payload: .object([:]), as: ServerBrowserEvent.self)
    }

    func listServerBrowsers(threadID: String) async throws -> ServerBrowserList {
        try await rpc.request("preview.list", payload: .object(["threadId": .string(threadID)]), as: ServerBrowserList.self)
    }

    func serverBrowserAccess() async throws -> ServerBrowserAccess {
        let ticket = try await api.webSocketTicket(for: environment)
        return try .ticketed(environmentURL: environment.httpBaseURL, ticket: ticket.ticket)
    }
}
