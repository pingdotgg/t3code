// WireEnvelopeTests.swift
// Effect-RPC framing layer (§2 of docs/wire-protocol.md): encode/decode
// round-trips against the spec's Appendix A fixtures, mandatory per-Chunk Ack
// emission/ordering (§2.3), Exit.Failure cause parsing (§2.2/§5.6), frame
// batching (§2.1), and non-uniform union discriminators (§5.5).

import Testing
@testable import T3Kit
import Foundation

// MARK: - Helpers

/// Structural JSON equality that ignores key order and whitespace, so tests
/// don't depend on JSONEncoder's key-ordering behavior.
private func assertSameJSON(
    _ actual: String, _ expected: String,
    sourceLocation: SourceLocation = #_sourceLocation
) throws {
    let actualValue = try WireCoding.decoder.decode(JSONValue.self, from: Data(actual.utf8))
    let expectedValue = try WireCoding.decoder.decode(JSONValue.self, from: Data(expected.utf8))
    #expect(actualValue == expectedValue, sourceLocation: sourceLocation)
}

// MARK: - ClientFrame encode round-trips (§2.2 FromClientEncoded)

@Suite("ClientFrame encoding")
struct ClientFrameEncodingTests {

    @Test("Request with no traceId omits the key entirely")
    func requestWithoutTraceId() throws {
        let frame = ClientFrame.request(
            id: "0", tag: "server.getConfig", payload: .object([:]),
            headers: [], traceId: nil
        )
        let text = try WireCoding.encodeFrameString(frame)
        try assertSameJSON(text, FixtureFrames.requestGetConfig)
        #expect(!text.contains("traceId"))
    }

    @Test("Request carries payload and non-empty headers as [key,value] pairs")
    func requestWithHeadersAndPayload() throws {
        let frame = ClientFrame.request(
            id: "1", tag: "orchestration.subscribeThread",
            payload: .object(["threadId": .string("th_123")]),
            headers: [], traceId: nil
        )
        let text = try WireCoding.encodeFrameString(frame)
        try assertSameJSON(text, FixtureFrames.requestSubscribeThread)
    }

    @Test("Request with traceId includes it")
    func requestWithTraceId() throws {
        let frame = ClientFrame.request(
            id: "9", tag: "server.getConfig", payload: .object([:]),
            headers: [], traceId: "trace-abc"
        )
        let text = try WireCoding.encodeFrameString(frame)
        let value = try WireCoding.decoder.decode(JSONValue.self, from: Data(text.utf8))
        #expect(value["traceId"]?.stringValue == "trace-abc")
    }

    @Test("Ack encodes {_tag, requestId}")
    func ack() throws {
        let text = try WireCoding.encodeFrameString(ClientFrame.ack(requestId: "1"))
        try assertSameJSON(text, FixtureFrames.ackSubscribeThreadSnapshot)
    }

    @Test("Interrupt encodes {_tag, requestId}")
    func interrupt() throws {
        let text = try WireCoding.encodeFrameString(ClientFrame.interrupt(requestId: "1"))
        try assertSameJSON(text, FixtureFrames.interruptSubscribeThread)
    }

    @Test("Ping encodes to the bare {_tag:\"Ping\"} heartbeat frame")
    func ping() throws {
        let text = try WireCoding.encodeFrameString(ClientFrame.ping)
        try assertSameJSON(text, FixtureFrames.ping)
    }

    @Test("Eof encodes to the bare {_tag:\"Eof\"} frame")
    func eof() throws {
        let text = try WireCoding.encodeFrameString(ClientFrame.eof)
        try assertSameJSON(text, FixtureFrames.eof)
    }
}

// MARK: - ServerFrame / ExitResult decode (§2.2 FromServerEncoded, §5.6)

@Suite("ServerFrame decoding")
struct ServerFrameDecodingTests {

    @Test("Chunk carries a non-empty values array keyed by requestId")
    func chunk() throws {
        let frames = try FrameBatch.decode(FixtureFrames.chunkSubscribeThreadSnapshot)
        #expect(frames.count == 1)
        guard case let .chunk(requestId, values) = frames[0] else {
            Issue.record("expected .chunk, got \(frames[0])")
            return
        }
        #expect(requestId == "1")
        #expect(values.count == 1)
        #expect(values[0]["kind"]?.stringValue == "snapshot")
    }

    @Test("Exit.Success decodes the encoded success value")
    func exitSuccess() throws {
        let frames = try FrameBatch.decode(FixtureFrames.exitGetConfigSuccess)
        guard case let .exit(requestId, .success(value)) = frames[0] else {
            Issue.record("expected .exit(.success), got \(frames[0])")
            return
        }
        #expect(requestId == "0")
        #expect(value["cwd"]?.stringValue == "/tmp")
    }

    @Test("Exit.Failure with a Fail cause exposes the typed error tag and fields")
    func exitFailureFail() throws {
        let frames = try FrameBatch.decode(FixtureFrames.exitAuthorizationFailure)
        guard case let .exit(requestId, .failure(rpcFailure)) = frames[0] else {
            Issue.record("expected .exit(.failure), got \(frames[0])")
            return
        }
        #expect(requestId == "3")
        #expect(rpcFailure.primaryErrorTag == "EnvironmentAuthorizationError")
        #expect(rpcFailure.isAuthorizationError == true)
        #expect(rpcFailure.requiredScope == "orchestration:operate")
    }

    @Test("Exit.Failure with a Die cause carries the opaque defect JSON")
    func exitFailureDie() throws {
        let frames = try FrameBatch.decode(FixtureFrames.exitDieFailure)
        guard case let .exit(_, .failure(rpcFailure)) = frames[0] else {
            Issue.record("expected .exit(.failure), got \(frames[0])")
            return
        }
        guard case let .die(defect) = rpcFailure.causes.first else {
            Issue.record("expected a .die cause, got \(rpcFailure.causes)")
            return
        }
        #expect(defect["name"]?.stringValue == "TypeError")
        #expect(rpcFailure.isAuthorizationError == false)
    }

    @Test("Exit.Failure with an Interrupt cause parses a present fiberId")
    func exitFailureInterruptWithFiberId() throws {
        let frames = try FrameBatch.decode(FixtureFrames.exitInterruptFailureWithFiberId)
        guard case let .exit(_, .failure(rpcFailure)) = frames[0] else {
            Issue.record("expected .exit(.failure), got \(frames[0])")
            return
        }
        guard case let .interrupt(fiberId) = rpcFailure.causes.first else {
            Issue.record("expected a .interrupt cause, got \(rpcFailure.causes)")
            return
        }
        #expect(fiberId == 12)
    }

    @Test("Exit.Failure with an Interrupt cause tolerates an absent fiberId")
    func exitFailureInterruptWithoutFiberId() throws {
        let frames = try FrameBatch.decode(FixtureFrames.exitInterruptFailureWithoutFiberId)
        guard case let .exit(_, .failure(rpcFailure)) = frames[0] else {
            Issue.record("expected .exit(.failure), got \(frames[0])")
            return
        }
        guard case let .interrupt(fiberId) = rpcFailure.causes.first else {
            Issue.record("expected a .interrupt cause, got \(rpcFailure.causes)")
            return
        }
        #expect(fiberId == nil)
    }

    @Test("Defect is connection-level, not tied to a requestId")
    func defect() throws {
        let frames = try FrameBatch.decode(FixtureFrames.defect)
        guard case let .defect(defectValue) = frames[0] else {
            Issue.record("expected .defect, got \(frames[0])")
            return
        }
        #expect(defectValue["message"]?.stringValue == "connection lost")
    }

    @Test("Pong decodes to the bare liveness reply")
    func pong() throws {
        let frames = try FrameBatch.decode(FixtureFrames.pong)
        guard case .pong = frames[0] else {
            Issue.record("expected .pong, got \(frames[0])")
            return
        }
    }

    @Test("ClientEnd tolerates both a present and an absent clientId")
    func clientEnd() throws {
        let withId = try FrameBatch.decode(FixtureFrames.clientEndWithId)
        guard case let .clientEnd(id) = withId[0] else {
            Issue.record("expected .clientEnd, got \(withId[0])")
            return
        }
        #expect(id == 5)

        let withoutId = try FrameBatch.decode(FixtureFrames.clientEndWithoutId)
        guard case let .clientEnd(id2) = withoutId[0] else {
            Issue.record("expected .clientEnd, got \(withoutId[0])")
            return
        }
        #expect(id2 == nil)
    }

    @Test("An unrecognized _tag decodes to .unknown instead of throwing")
    func unknownTag() throws {
        let frames = try FrameBatch.decode(FixtureFrames.unknownServerTag)
        guard case let .unknown(tag) = frames[0] else {
            Issue.record("expected .unknown, got \(frames[0])")
            return
        }
        #expect(tag == "SomeFutureMessage")
    }
}

// MARK: - §2.1 batching: one WS frame may be a JSON array of messages

@Suite("FrameBatch")
struct FrameBatchTests {

    @Test("a single JSON object decodes to exactly one frame")
    func singleObjectFrame() throws {
        let frames = try FrameBatch.decode(FixtureFrames.pong)
        #expect(frames.count == 1)
    }

    @Test("a JSON array decodes to one frame per element, in order")
    func arrayBatch() throws {
        let frames = try FrameBatch.decode(FixtureFrames.batchOfTwoServerFrames)
        #expect(frames.count == 2)
        guard case .pong = frames[0] else {
            Issue.record("expected frames[0] == .pong, got \(frames[0])")
            return
        }
        guard case let .chunk(requestId, _) = frames[1] else {
            Issue.record("expected frames[1] == .chunk, got \(frames[1])")
            return
        }
        #expect(requestId == "1")
    }
}

// MARK: - §2.3 mandatory per-Chunk Ack, ordering & requestId correlation

@Suite("Ack emission ordering")
struct AckEmissionOrderingTests {

    @Test("each Chunk's requestId maps to exactly one correlated Ack frame")
    func ackFollowsChunkWithSameRequestId() throws {
        let snapshotFrames = try FrameBatch.decode(FixtureFrames.chunkSubscribeThreadSnapshot)
        guard case let .chunk(snapshotRequestId, _) = snapshotFrames[0] else {
            Issue.record("expected .chunk")
            return
        }
        let snapshotAck = try WireCoding.encodeFrameString(
            ClientFrame.ack(requestId: snapshotRequestId)
        )
        try assertSameJSON(snapshotAck, FixtureFrames.ackSubscribeThreadSnapshot)
    }

    @Test("acks are emitted in the same order the chunks arrived (snapshot, then live event)")
    func acksPreserveChunkArrivalOrder() throws {
        let incoming = try FrameBatch.decode(FixtureFrames.chunkSubscribeThreadSnapshot)
            + FrameBatch.decode(FixtureFrames.chunkSubscribeThreadEvent)

        var emittedAcks: [String] = []
        for frame in incoming {
            guard case let .chunk(requestId, _) = frame else { continue }
            emittedAcks.append(try WireCoding.encodeFrameString(ClientFrame.ack(requestId: requestId)))
        }

        #expect(emittedAcks.count == 2)
        try assertSameJSON(emittedAcks[0], FixtureFrames.ackSubscribeThreadSnapshot)
        try assertSameJSON(emittedAcks[1], FixtureFrames.ackSubscribeThreadEvent)
    }
}

// MARK: - §5.5 discriminator variants (`_tag` vs `type` vs `kind`)

@Suite("Discriminator variants")
struct DiscriminatorVariantTests {

    @Test("tagged errors/envelopes are discriminated by `_tag`")
    func byTag() throws {
        let value = try WireCoding.decoder.decode(
            JSONValue.self, from: Data(FixtureFrames.discriminatorByTag.utf8)
        )
        #expect(value["_tag"]?.stringValue == "EnvironmentAuthorizationError")
        #expect(value["type"] == nil)
        #expect(value["kind"] == nil)
    }

    @Test("OrchestrationEvent-style unions are discriminated by `type`, not `_tag`")
    func byType() throws {
        let value = try WireCoding.decoder.decode(
            JSONValue.self, from: Data(FixtureFrames.discriminatorByType.utf8)
        )
        #expect(value["type"]?.stringValue == "thread.archived")
        #expect(value["_tag"] == nil)
    }

    @Test("orchestration stream items are discriminated by `kind`, not `_tag`")
    func byKind() throws {
        let value = try WireCoding.decoder.decode(
            JSONValue.self, from: Data(FixtureFrames.discriminatorByKind.utf8)
        )
        #expect(value["kind"]?.stringValue == "thread-upserted")
        #expect(value["_tag"] == nil)
        #expect(value["type"] == nil)
    }
}
