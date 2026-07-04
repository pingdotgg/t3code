// RpcConnectionTransport.swift
// Adapter conforming `RpcConnection` (the raw WebSocket/effect-RPC actor) to
// `T3RpcTransport`, the minimal contract `T3Client` consumes. The fix-stage
// review noted this adapter did not exist yet.
//
// `RpcConnection` already exposes `request(tag:payload:headers:traceId:)` and
// `stream(tag:payload:headers:traceId:)`. `T3RpcTransport` requires the
// two-argument forms `request(tag:payload:)` / `stream(tag:payload:)`. A Swift
// protocol requirement is NOT satisfied by a method that merely has additional
// defaulted parameters (the full names differ), so these thin forwarders are
// required rather than a bare `extension RpcConnection: T3RpcTransport {}`.
//
// Both `stream` signatures are `async throws` and yield
// `AsyncThrowingStream<JSONValue, Error>`: the initial `Request` frame can fail
// to send, and that failure must propagate to the caller synchronously with the
// subscription attempt rather than only surfacing once someone iterates.

import Foundation

extension RpcConnection: T3RpcTransport {
    public func request(tag: String, payload: JSONValue) async throws -> JSONValue {
        try await request(tag: tag, payload: payload, headers: [], traceId: nil)
    }

    public func stream(
        tag: String, payload: JSONValue
    ) async throws -> AsyncThrowingStream<JSONValue, Error> {
        try await stream(tag: tag, payload: payload, headers: [], traceId: nil)
    }
}
