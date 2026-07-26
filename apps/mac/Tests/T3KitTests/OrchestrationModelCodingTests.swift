// OrchestrationModelCodingTests.swift
// Decode regression tests for the orchestration read models whose wire shape
// drifted from the Swift models: the two-variant ChatAttachment union
// (orchestration.ts:220), the `{kind:"synchronized"}` stream items
// (orchestration.ts:563-573, 1358-1371), and the forward-compat `.other`
// event payload fallback.

import Testing
@testable import T3Kit
import Foundation

@Suite("OrchestrationModelCoding")
struct OrchestrationModelCodingTests {

    // MARK: - ChatAttachment union (image | text)

    @Test("ChatAttachment decodes the image variant")
    func chatAttachmentDecodesImage() throws {
        let json = #"""
        {"type":"image","id":"att-1","name":"shot.png","mimeType":"image/png","sizeBytes":1234}
        """#
        let attachment = try WireCoding.decoder.decode(
            ChatAttachment.self, from: Data(json.utf8))
        guard case .image(let image) = attachment else {
            Issue.record("expected .image, got \(attachment)")
            return
        }
        #expect(image.id == "att-1")
        #expect(image.name == "shot.png")
        #expect(image.mimeType == "image/png")
        #expect(image.sizeBytes == 1234)
        #expect(attachment.preview == nil)
    }

    @Test("ChatAttachment decodes the text variant with preview")
    func chatAttachmentDecodesText() throws {
        let json = #"""
        {"type":"text","id":"att-2","name":"notes.txt","mimeType":"text/plain","sizeBytes":42,"preview":"hello world"}
        """#
        let attachment = try WireCoding.decoder.decode(
            ChatAttachment.self, from: Data(json.utf8))
        guard case .text(let text) = attachment else {
            Issue.record("expected .text, got \(attachment)")
            return
        }
        #expect(text.type == "text")
        #expect(text.id == "att-2")
        #expect(text.name == "notes.txt")
        #expect(text.mimeType == "text/plain")
        #expect(text.sizeBytes == 42)
        #expect(text.preview == "hello world")
        #expect(attachment.preview == "hello world")
    }

    @Test("ChatAttachment round-trips both variants with the discriminator")
    func chatAttachmentRoundTrip() throws {
        let image = ChatAttachment.image(
            ChatImageAttachment(id: "a", name: "a.png", mimeType: "image/png", sizeBytes: 1))
        let text = ChatAttachment.text(
            ChatTextAttachment(
                id: "b", name: "b.txt", mimeType: "text/plain", sizeBytes: 2, preview: "p"))
        for original in [image, text] {
            let data = try WireCoding.encoder.encode(original)
            let discriminator = try WireCoding.decoder.decode(JSONValue.self, from: data)
            #expect(discriminator["type"]?.stringValue != nil)
            #expect(try WireCoding.decoder.decode(ChatAttachment.self, from: data) == original)
        }
    }

    // MARK: - `{kind:"synchronized"}` stream items

    @Test("OrchestrationShellStreamItem decodes the synchronized marker")
    func shellStreamItemDecodesSynchronized() throws {
        let item = try WireCoding.decoder.decode(
            OrchestrationShellStreamItem.self, from: Data(#"{"kind":"synchronized"}"#.utf8))
        guard case .synchronized = item else {
            Issue.record("expected .synchronized, got \(item)")
            return
        }
    }

    @Test("OrchestrationThreadStreamItem decodes the synchronized marker")
    func threadStreamItemDecodesSynchronized() throws {
        let item = try WireCoding.decoder.decode(
            OrchestrationThreadStreamItem.self, from: Data(#"{"kind":"synchronized"}"#.utf8))
        guard case .synchronized = item else {
            Issue.record("expected .synchronized, got \(item)")
            return
        }
    }

    // MARK: - OrchestrationEvent `.other` forward compatibility

    @Test("unknown event type without a payload key decodes as .other with null payload")
    func otherEventWithoutPayloadKey() throws {
        let json = #"""
        {"sequence":7,"eventId":"evt-1","aggregateKind":"thread","aggregateId":"t-1",
         "occurredAt":"2026-01-01T00:00:00Z","metadata":{},"type":"thread.future-thing"}
        """#
        let event = try WireCoding.decoder.decode(OrchestrationEvent.self, from: Data(json.utf8))
        guard case .other(let type, let payload) = event.payload else {
            Issue.record("expected .other, got \(event.payload)")
            return
        }
        #expect(type == "thread.future-thing")
        #expect(payload == .null)
    }

    @Test("unknown event type keeps a present payload")
    func otherEventWithPayload() throws {
        let json = #"""
        {"sequence":8,"eventId":"evt-2","aggregateKind":"thread","aggregateId":"t-1",
         "occurredAt":"2026-01-01T00:00:00Z","metadata":{},"type":"thread.future-thing",
         "payload":{"x":1}}
        """#
        let event = try WireCoding.decoder.decode(OrchestrationEvent.self, from: Data(json.utf8))
        guard case .other(_, let payload) = event.payload else {
            Issue.record("expected .other, got \(event.payload)")
            return
        }
        #expect(payload == .object(["x": .int(1)]))
    }

    // MARK: - Advisor/Planner executor fields

    @Test("ProviderInteractionMode decodes the advisor wire value")
    func interactionModeDecodesAdvisor() throws {
        let mode = try WireCoding.decoder.decode(
            ProviderInteractionMode.self, from: Data(#""advisor""#.utf8))
        #expect(mode == .advisor)
    }

    @Test("ThreadExecutorModelSetPayload defaults executorMaxSubAgents to 3 when absent")
    func executorModelSetPayloadDefaultsMaxSubAgents() throws {
        let json = #"""
        {"threadId":"thr-1","executorModelSelection":null,"updatedAt":"2026-01-01T00:00:00Z"}
        """#
        let payload = try WireCoding.decoder.decode(
            ThreadExecutorModelSetPayload.self, from: Data(json.utf8))
        #expect(payload.threadId == "thr-1")
        #expect(payload.executorModelSelection == nil)
        #expect(payload.executorMaxSubAgents == 3)
    }

    @Test("ThreadExecutorModelSetPayload decodes a present executorMaxSubAgents")
    func executorModelSetPayloadDecodesMaxSubAgents() throws {
        let json = #"""
        {"threadId":"thr-1","executorModelSelection":{"instanceId":"codex","model":"gpt-5-codex"},
         "executorMaxSubAgents":8,"updatedAt":"2026-01-01T00:00:00Z"}
        """#
        let payload = try WireCoding.decoder.decode(
            ThreadExecutorModelSetPayload.self, from: Data(json.utf8))
        #expect(payload.executorModelSelection?.model == "gpt-5-codex")
        #expect(payload.executorMaxSubAgents == 8)
    }

    @Test("OrchestrationThreadShell defaults executorMaxSubAgents to 3 when absent")
    func threadShellDefaultsMaxSubAgents() throws {
        let json = #"""
        {"id":"thr-1","projectId":"prj-1","title":"T",
         "modelSelection":{"instanceId":"codex","model":"gpt-5-codex"},
         "runtimeMode":"full-access","interactionMode":"advisor",
         "executorModelSelection":null,"createdAt":"2026-01-01T00:00:00Z",
         "updatedAt":"2026-01-01T00:00:00Z","hasPendingApprovals":false,
         "hasPendingUserInput":false,"hasActionableProposedPlan":false}
        """#
        let shell = try WireCoding.decoder.decode(
            OrchestrationThreadShell.self, from: Data(json.utf8))
        #expect(shell.interactionMode == .advisor)
        #expect(shell.executorModelSelection == nil)
        #expect(shell.executorMaxSubAgents == 3)
    }
}
