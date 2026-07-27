// AutoReviewSettingsCodingTests.swift
// The auto-review fix-model and parallelism settings cross the wire in both
// directions: decoded out of `ServerSettings`, and sent back as a nested
// `AutoReviewSettingsPatch`. Both halves have to agree with the server schema,
// and a server that predates these fields must still decode.

import Foundation
import Testing

@testable import T3Kit

@Suite("Auto-review settings coding")
struct AutoReviewSettingsCodingTests {

    private func decode(_ json: String) throws -> AutoReviewSettings {
        try WireCoding.decoder.decode(AutoReviewSettings.self, from: Data(json.utf8))
    }

    private func encodedPatch(_ patch: AutoReviewSettingsPatch) throws -> JSONValue {
        let data = try WireCoding.encoder.encode(patch)
        return try WireCoding.decoder.decode(JSONValue.self, from: data)
    }

    @Test("a server without the new fields decodes to the v1 defaults")
    func decodesLegacyPayload() throws {
        let settings = try decode(
            """
            {"enabled":true,"mode":"auto","mentionHandle":"surgecode","pollInterval":60000,
             "autoFixOriginThread":true,"maxDiffBytes":400000,"concurrency":1,"maxAttempts":2,
             "projects":{}}
            """)

        #expect(settings.fixModelMode == "thread")
        #expect(settings.fixModelSelection == nil)
        #expect(settings.fixConcurrency == 1)
    }

    @Test("the fix model and both concurrency settings decode")
    func decodesFixModelAndConcurrency() throws {
        let settings = try decode(
            """
            {"enabled":true,"mode":"auto","mentionHandle":"surgecode","pollInterval":60000,
             "autoFixOriginThread":true,"fixModelMode":"custom",
             "fixModelSelection":{"instanceId":"claude","model":"opus-5"},
             "maxDiffBytes":400000,"concurrency":4,"fixConcurrency":3,"maxAttempts":2,
             "projects":{}}
            """)

        #expect(settings.fixModelMode == "custom")
        #expect(settings.fixModelSelection?.instanceId == "claude")
        #expect(settings.fixModelSelection?.model == "opus-5")
        #expect(settings.concurrency == 4)
        #expect(settings.fixConcurrency == 3)
    }

    @Test("a custom fix model is sent with its selection")
    func encodesCustomFixModel() throws {
        let encoded = try encodedPatch(
            AutoReviewSettingsPatch(
                fixModelMode: "custom",
                fixModelSelection: ModelSelection(instanceId: "claude", model: "opus-5"),
                concurrency: 4,
                fixConcurrency: 3))

        guard case .object(let fields) = encoded else {
            Issue.record("expected an object, got \(encoded)")
            return
        }
        #expect(fields["fixModelMode"] == .string("custom"))
        #expect(fields["concurrency"] == .int(4))
        #expect(fields["fixConcurrency"] == .int(3))
        guard case .object(let selection)? = fields["fixModelSelection"] else {
            Issue.record("expected a fixModelSelection object")
            return
        }
        #expect(selection["instanceId"] == .string("claude"))
        #expect(selection["model"] == .string("opus-5"))
    }

    @Test("omitted patch fields stay off the wire so the server keeps its value")
    func omitsUnsetFields() throws {
        let encoded = try encodedPatch(AutoReviewSettingsPatch(fixModelMode: "review"))

        guard case .object(let fields) = encoded else {
            Issue.record("expected an object, got \(encoded)")
            return
        }
        #expect(fields["fixModelMode"] == .string("review"))
        // "review" carries no explicit model, and sending a null here would
        // clear a selection the user may switch back to.
        #expect(fields["fixModelSelection"] == nil)
        #expect(fields["concurrency"] == nil)
        #expect(fields["fixConcurrency"] == nil)
    }

    @Test("an incomplete custom pick sends the mode without clearing the stored model")
    func customModeWithoutSelectionOmitsTheModel() throws {
        // The UI can reach "custom" before a model has been chosen. Sending a
        // null selection then would wipe whatever the server had stored, so
        // the mode travels alone and the previous pick survives.
        let encoded = try encodedPatch(
            AutoReviewSettingsPatch(fixModelMode: "custom", fixModelSelection: nil))

        guard case .object(let fields) = encoded else {
            Issue.record("expected an object, got \(encoded)")
            return
        }
        #expect(fields["fixModelMode"] == .string("custom"))
        #expect(fields["fixModelSelection"] == nil)
    }
}
