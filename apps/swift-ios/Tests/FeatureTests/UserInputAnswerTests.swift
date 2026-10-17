import Foundation
import Testing
@testable import T3Code

@Suite("User input answers")
struct UserInputAnswerTests {
    @Test
    func editorAnswersPreserveWhitespaceAndPermitDeletingThePrefill() throws {
        let wire = try JSONDecoder().decode(OrchestrationV2InputQuestion.self, from: Data(
            #"{"id":"edit","header":"Edit","question":"Update text","options":[],"initialAnswer":"  first\nsecond\n"}"#.utf8
        ))
        var question = FeatureInputQuestion(id: wire.id, header: wire.header, question: wire.question)
        question.initialAnswer = wire.initialAnswer
        var draft = FeatureInputDraftAnswer(question: question)
        #expect(draft.customAnswer == "  first\nsecond\n")
        #expect(draft.normalized(for: question) == .text("  first\nsecond\n"))
        draft.setCustomAnswer("", for: question)
        #expect(draft.normalized(for: question) == .text(""))
        draft.setCustomAnswer("  replacement\n", for: question)
        #expect(draft.normalized(for: question) == .text("  replacement\n"))
        question.allowCustomAnswer = false
        #expect(draft.normalized(for: question) == nil)
        #expect(FeatureInputDraftAnswer(question: question).customAnswer == "")
    }

    @Test
    func selectingAnOptionReplacesTheEditorPrefill() {
        var question = valueQuestion()
        question.initialAnswer = "Seed"
        var draft = FeatureInputDraftAnswer(question: question)
        draft.toggleOption("existing_branch", for: question)
        #expect(draft.normalized(for: question) == .text("existing_branch"))
        draft.setCustomAnswer("", for: question)
        #expect(draft.selectedOptionValues.isEmpty)
        #expect(draft.normalized(for: question) == .text(""))
    }

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
        #expect(input.canRespond)
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
    func singleSelectUsesDistinctWireValuesForDuplicateLabels() {
        let question = valueQuestion()
        #expect(Set(question.options.map(\.id)).count == question.options.count)
        var draft = FeatureInputDraftAnswer()
        #expect(draft.normalized(for: question) == nil)
        draft.toggleOption("existing_branch", for: question)
        #expect(draft.normalized(for: question)?.jsonValue == .string("existing_branch"))
        draft.toggleOption("", for: question)
        #expect(draft.isOptionSelected("", for: question))
        #expect(!draft.isOptionSelected("existing_branch", for: question))
        #expect(draft.normalized(for: question)?.jsonValue == .string(""))
        draft.toggleOption("  exact  ", for: question)
        #expect(draft.normalized(for: question)?.jsonValue == .string("  exact  "))
    }

    @Test
    func multipleSelectionsKeepEmptyAndUntrimmedWireValues() {
        let question = valueQuestion(allowsMultiple: true)
        var draft = FeatureInputDraftAnswer()
        draft.toggleOption("existing_branch", for: question)
        draft.toggleOption("", for: question)
        draft.toggleOption("  exact  ", for: question)
        #expect(draft.normalized(for: question)?.jsonValue == .array([
            .string("existing_branch"), .string(""), .string("  exact  "),
        ]))
        draft.toggleOption("existing_branch", for: question)
        draft.toggleOption("  exact  ", for: question)
        #expect(draft.normalized(for: question)?.jsonValue == .array([.string("")]))
        draft.toggleOption("", for: question)
        #expect(draft.normalized(for: question) == nil)
    }

    @Test(arguments: [false, true])
    func customTextReplacesSelectionsAndSelectionClearsCustomText(allowsMultiple: Bool) {
        let question = valueQuestion(allowsMultiple: allowsMultiple)
        var draft = FeatureInputDraftAnswer()
        draft.toggleOption("", for: question)
        draft.setCustomAnswer("  existing_branch  ", for: question)
        #expect(draft.selectedOptionValues.isEmpty)
        #expect(draft.customAnswer == "  existing_branch  ")
        #expect(draft.normalized(for: question) == .text("existing_branch"))
        #expect(!draft.isOptionSelected("existing_branch", for: question))
        draft.setCustomAnswer("", for: question)
        #expect(draft.normalized(for: question) == nil)
        draft.setCustomAnswer("Custom", for: question)
        draft.toggleOption("existing_branch", for: question)
        #expect(draft.customAnswer.isEmpty)
        #expect(draft.normalized(for: question) == (
            allowsMultiple ? .selections(["existing_branch"]) : .text("existing_branch")
        ))
    }

    @Test
    func legacyLabelsTrimButExplicitValuesDoNot() throws {
        let option = try JSONDecoder().decode(FeatureInputOption.self, from: Data(
            #"{"label":"  Legacy  ","detail":"No value"}"#.utf8
        ))
        #expect(option.value == nil)
        #expect(option.wireValue == "Legacy")
        let question = FeatureInputQuestion(id: "legacy", header: "Legacy", question: "Choose", options: [option])
        var draft = FeatureInputDraftAnswer()
        draft.toggleOption(option.wireValue, for: question)
        draft.setCustomAnswer("  ", for: question)
        #expect(draft.normalized(for: question) == .text("Legacy"))
        draft.setCustomAnswer("  custom answer  ", for: question)
        #expect(draft.normalized(for: question) == .text("custom answer"))
    }

    @Test
    func changedQuestionsDiscardInvalidSelectionsAndRejectDisallowedCustomAnswers() {
        var question = valueQuestion()
        var draft = FeatureInputDraftAnswer()
        draft.toggleOption("existing_branch", for: question)
        question.options.removeFirst()
        #expect(draft.normalized(for: question) == nil)
        draft.toggleOption("existing_branch", for: question)
        #expect(draft.normalized(for: question) == nil)
        draft.setCustomAnswer("Custom", for: question)
        question.allowCustomAnswer = false
        #expect(draft.normalized(for: question) == nil)
        draft.setCustomAnswer("Replacement", for: question)
        #expect(draft.customAnswer == "Custom")
        draft.toggleOption("", for: question)
        #expect(draft.normalized(for: question) == .text(""))
    }

    @Test
    func cachedApprovalsWithoutCapabilityOrWarningRemainUsable() throws {
        let approval = try JSONDecoder().decode(FeatureApproval.self, from: Data(
            #"{"id":"old","threadID":"thread","kind":"command","title":"Run","detail":"ls","options":[{"decision":"allowOnce","label":"Approve"}]}"#.utf8
        ))
        #expect(approval.canRespond)
        #expect(approval.options?.first?.warning == nil)
    }

    private func valueQuestion(allowsMultiple: Bool = false) -> FeatureInputQuestion {
        FeatureInputQuestion(
            id: "branch", header: "Branch", question: "Which branch?",
            options: [
                .init(label: "Use existing branch", detail: "Named", value: "existing_branch"),
                .init(label: "Use existing branch", detail: "Current", value: ""),
                .init(label: "Exact", detail: "Keep whitespace", value: "  exact  "),
            ],
            allowsMultiple: allowsMultiple
        )
    }
}
