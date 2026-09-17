import Foundation
import Testing
@testable import T3Code

@Suite("User input answers")
struct UserInputAnswerTests {
    @Test
    func attachmentDraftsKeepEachFileWithItsQuestion() async throws {
        let first = FeatureDraftAttachment(data: Data([1]), filename: "one.png", mimeType: "image/png")
        let second = FeatureDraftAttachment(data: Data([2]), filename: "two.png", mimeType: "image/png")
        let value = ["first": [first], "second": [second]]
        #expect(try FeatureQuestionAttachmentDraft.decode(FeatureQuestionAttachmentDraft.encode(value)) == value)
        #expect(try FeatureQuestionAttachmentDraft.encode(["empty": []]).isEmpty)
        let left = FeatureScopedID.input(environmentID: "left", wireID: "same-request")
        let right = FeatureScopedID.input(environmentID: "right", wireID: "same-request")
        #expect(FeatureQuestionAttachmentDraft.key(inputID: left) != FeatureQuestionAttachmentDraft.key(inputID: right))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("drafts.json")
        let store = FeatureComposerDraftStore(fileURL: fileURL)
        let key = FeatureQuestionAttachmentDraft.key(inputID: left)
        try await store.setDraft(FeatureQuestionAttachmentDraft.encode(value), for: key)
        let reopened = FeatureComposerDraftStore(fileURL: fileURL)
        #expect(try await FeatureQuestionAttachmentDraft.decode(reopened.draft(for: key)) == value)
    }

    @Test
    func answerHistoryRendersQuestionTextAndAttachmentsWithoutRawJSON() {
        let activity = OrchestrationActivity(
            id: "answer", tone: "info", kind: "user-input.answer-submitted", summary: "Question answer submitted",
            payload: .object([
                "requestId": .string("request"),
                "questionTextById": .object(["scope": .string("Which parts?")]),
                "answers": .object(["scope": .array([.string("Server"), .string("Web")])]),
                "attachmentsByQuestionId": .object(["scope": .array([
                    .object([
                        "type": .string("image"), "id": .string("image"),
                        "name": .string("screenshot.png"), "mimeType": .string("image/png"), "sizeBytes": .number(2),
                    ]),
                    .null,
                ])]),
            ]), turnId: nil, sequence: nil, createdAt: "2026-09-08T12:00:00Z"
        )
        let messages = NativeQuestionAnswerHistory.messages(activity, createdAt: .distantPast)
        #expect(messages.count == 1)
        #expect(messages.first?.text == "Which parts?\n\nServer, Web")
        #expect(messages.first?.role == .user)
        #expect(messages.first?.attachments.map(\.id) == ["image"])
    }

    @Test
    func cachedQuestionsWithoutResponseModeCannotBeDismissed() throws {
        let input = try JSONDecoder().decode(FeatureUserInput.self, from: Data(
            #"{"id":"old","threadID":"thread","questions":[]}"#.utf8
        ))
        #expect(!input.canDismiss)
    }

    @Test
    func testCodableShapeMatchesProviderWireValues() throws {
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()

        let textData = try encoder.encode(FeatureInputAnswer.text("Deploy"))
        let selectionsData = try encoder.encode(
            FeatureInputAnswer.selections(["Server", "Web"])
        )

        #expect(try decoder.decode(JSONValue.self, from: textData) == .string("Deploy"))
        #expect(
            try decoder.decode(JSONValue.self, from: selectionsData)
                == .array([.string("Server"), .string("Web")])
        )
        #expect(try decoder.decode(FeatureInputAnswer.self, from: textData) == .text("Deploy"))
        #expect(
            try decoder.decode(FeatureInputAnswer.self, from: selectionsData)
                == .selections(["Server", "Web"])
        )
    }

    @Test
    func testNativeJSONMappingPreservesStringAndArrayTypes() {
        #expect(FeatureInputAnswer.text("Deploy").jsonValue == .string("Deploy"))
        #expect(
            FeatureInputAnswer.selections(["Server", "Web"]).jsonValue
                == .array([.string("Server"), .string("Web")])
        )
    }

    @Test
    func testMultiSelectTogglesWithoutFlatteningSelections() {
        let first = FeatureInputAnswer.selections([])
            .togglingOption("Server", allowsMultiple: true)
        let second = first.togglingOption("Web", allowsMultiple: true)
        let deselected = second.togglingOption("Server", allowsMultiple: true)

        #expect(first == .selections(["Server"]))
        #expect(second == .selections(["Server", "Web"]))
        #expect(deselected == .selections(["Web"]))
        #expect(
            second.togglingOption("CLI", allowsMultiple: false)
                == .text("CLI")
        )
    }

    @Test
    func testAnswersNormalizeBeforeSubmission() {
        #expect(FeatureInputAnswer.text("  ship it  ").normalized == .text("ship it"))
        #expect(
            FeatureInputAnswer.selections([" Server ", "", "Server", "Web"]).normalized
                == .selections(["Server", "Web"])
        )
        #expect(FeatureInputAnswer.text("   ").normalized == nil)
        #expect(FeatureInputAnswer.selections([]).normalized == nil)
    }

    @Test
    func testMultiSelectCustomTextStaysInTheSelectionArray() {
        let question = FeatureInputQuestion(
            id: "surfaces",
            header: "Surfaces",
            question: "Where should this ship?",
            options: [
                .init(label: "Server", detail: "Backend"),
                .init(label: "Web", detail: "Browser"),
            ],
            allowsMultiple: true
        )
        let selected = FeatureInputAnswer.selections(["Server"])
        let withCustom = FeatureComposerCustomAnswer.replacingText(
            in: selected,
            with: "CLI",
            for: question
        )

        #expect(withCustom == .selections(["Server", "CLI"]))
        #expect(FeatureComposerCustomAnswer.text(in: withCustom, for: question) == "CLI")
        #expect(
            FeatureComposerCustomAnswer.replacingText(
                in: withCustom,
                with: "",
                for: question
            ) == .selections(["Server"])
        )
    }
}
