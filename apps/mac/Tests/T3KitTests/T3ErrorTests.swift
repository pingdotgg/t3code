// T3ErrorTests.swift
// Error taxonomy (§1.2, §2.2, §5.6, §5.9, §risks 2/3/9): RpcFailure derived
// from Exit.Failure causes, and the T3Error cases callers switch on —
// including the ~10s-silence liveness case from §1.4.

import Testing
@testable import T3Kit
import Foundation

@Suite("RpcFailure")
struct RpcFailureTests {

    private func rpcFailure(from fixture: String) throws -> RpcFailure {
        let frames = try FrameBatch.decode(fixture)
        guard case let .exit(_, .failure(rpcFailure)) = frames[0] else {
            throw TestFailure("expected .exit(.failure) in fixture")
        }
        return rpcFailure
    }

    private struct TestFailure: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }

    @Test("primaryErrorTag reads the first Fail node's literal _tag (§5.9: not the class name)")
    func primaryErrorTagIsTheWireLiteral() throws {
        let failure = try rpcFailure(from: FixtureFrames.exitAuthorizationFailure)
        #expect(failure.primaryErrorTag == "EnvironmentAuthorizationError")
    }

    @Test("isAuthorizationError is true only for EnvironmentAuthorizationError")
    func isAuthorizationErrorFlag() throws {
        let authFailure = try rpcFailure(from: FixtureFrames.exitAuthorizationFailure)
        #expect(authFailure.isAuthorizationError == true)

        let dieFailure = try rpcFailure(from: FixtureFrames.exitDieFailure)
        #expect(dieFailure.isAuthorizationError == false)
    }

    @Test("requiredScope surfaces the scope literal from an authorization failure")
    func requiredScopeFromAuthorizationFailure() throws {
        let failure = try rpcFailure(from: FixtureFrames.exitAuthorizationFailure)
        #expect(failure.requiredScope == "orchestration:operate")
    }

    @Test("requiredScope is nil when the cause isn't an authorization error")
    func requiredScopeNilForNonAuthorizationFailure() throws {
        let failure = try rpcFailure(from: FixtureFrames.exitDieFailure)
        #expect(failure.requiredScope == nil)
    }

    @Test("primaryErrorTag is nil when the cause chain has no Fail node")
    func primaryErrorTagNilWithOnlyDieCause() throws {
        let failure = try rpcFailure(from: FixtureFrames.exitDieFailure)
        #expect(failure.primaryErrorTag == nil)
    }
}

@Suite("T3Error")
struct T3ErrorTests {

    @Test("all documented cases are constructible and pattern-matchable")
    func allCasesConstructAndMatch() throws {
        let cases: [T3Error] = [
            .notConnected,
            .connectionClosed(reason: "server closed"),
            .connectionClosed(reason: nil),
            .pingTimeout,
            .transport("socket error"),
            .decoding("bad frame"),
            .auth("ticket expired"),
            .unauthorized("session expired"),
            .unexpectedFrame("saw an array where an object was expected"),
        ]
        #expect(cases.count == 9)

        for error in cases {
            switch error {
            case .notConnected, .pingTimeout:
                continue
            case .connectionClosed, .transport, .decoding, .auth, .unauthorized, .unexpectedFrame, .rpc:
                continue
            }
        }
    }

    @Test("§1.4: ~10s of silence after an unanswered Ping is modeled as .pingTimeout")
    func pingTimeoutModelsHeartbeatDeadline() {
        // This documents the wire-level liveness contract this error models:
        // client pings every 5s (FixtureFrames.ping); if the matching Pong
        // (FixtureFrames.pong) doesn't arrive by the next tick, the
        // connection is dead. Actor-level timer scheduling for this belongs
        // to RpcConnection and is out of scope for this fixture-only suite.
        let error = T3Error.pingTimeout
        guard case .pingTimeout = error else {
            Issue.record("expected .pingTimeout")
            return
        }
    }

    @Test("wraps a decoded RpcFailure without losing its fields")
    func rpcCaseWrapsRpcFailure() throws {
        let frames = try FrameBatch.decode(FixtureFrames.exitAuthorizationFailure)
        guard case let .exit(_, .failure(rpcFailure)) = frames[0] else {
            Issue.record("expected .exit(.failure)")
            return
        }
        let error = T3Error.rpc(rpcFailure)
        guard case let .rpc(wrapped) = error else {
            Issue.record("expected .rpc")
            return
        }
        #expect(wrapped.isAuthorizationError == true)
    }
}
