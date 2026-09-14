import Foundation
import Testing
@testable import T3Code

@Suite("Composer context contracts")
struct ComposerContextContractTests {
    @Test func knownRecordsAndFuturePayloadsRoundTrip() throws {
        let data = Data(#"{"version":1,"records":[{"version":1,"contextId":"file_1","kind":"file","label":"log","attachmentId":"a1","name":"log.txt","mimeType":"text/plain","sizeBytes":7},{"version":1,"contextId":"terminal_1","kind":"terminal","label":"output","terminalId":"default","terminalLabel":"Shell","lineStart":4,"lineEnd":5,"text":"one\ntwo"},{"version":1,"contextId":"element_1","kind":"element","label":"button","pageUrl":"https://example.com","pageTitle":null,"tagName":"button","selector":null,"htmlPreview":"<button>","componentName":null,"source":null,"styles":""},{"version":1,"contextId":"future_1","kind":"future-kind","label":"future","payload":{"large":9007199254740993,"nested":[null,true,"kept"]}},{"version":1,"contextId":"bad","kind":"terminal","label":"malformed known record","payload":{"must":"not become unknown"}}]}"#.utf8)
        let context = try JSONDecoder().decode(OrchestrationMessageContext.self, from: data)
        #expect(context.records.map(\.kind) == ["file", "terminal", "element", "future-kind"])
        #expect(try JSONDecoder().decode(OrchestrationMessageContext.self, from: JSONEncoder().encode(context)) == context)
        let element = try JSONValue.encode(context.records[2])
        #expect(element["source"] == .null)
        #expect(element["pageTitle"] == .null)
        #expect(element["selector"] == .null)
    }

    @Test func duplicateIDsRejectTheEnvelope() {
        let record = ComposerContextRecord(contextId: "same", label: "one", payload: .mention(.init(path: "src/a.swift")))
        let context = OrchestrationMessageContext(records: [record, record])
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(OrchestrationMessageContext.self, from: JSONEncoder().encode(context))
        }
    }

    @Test func linksKeepIdentityPositionAndSanitizedLabels() {
        let record = ComposerContextRecord(contextId: "image_1", label: " [shot]\\\n image ", payload: .image(.init(
            attachmentId: "a1", name: "shot.png", mimeType: "image/png", sizeBytes: 4
        )))
        let link = ComposerContextReferences.format(record)
        #expect(link == "![shot image](t3-context://v1/image/image_1)")
        let text = "🐱 inspect \(link) here"
        let refs = ComposerContextReferences.collect(text)
        #expect(refs.count == 1)
        #expect(refs.first?.range.location == "🐱 inspect ".utf16.count)
        #expect(refs.first?.image == true)
        #expect(ComposerContextReferences.displayText(text) == "🐱 inspect shot image here")
        #expect(ComposerContextReferences.parseHref("t3-context://v1/image/a/b") == nil)
        #expect(ComposerContextReferences.parseHref("t3-context://v2/image/a") == nil)
        #expect(ComposerContextReferences.parseHref("t3-context://v1/image/a%20b") == nil)
    }

    @Test func legacyProjectionMatchesSharedEnvelopeAndEscapesCapturedText() {
        let record = ComposerContextRecord(contextId: "term", label: "Shell", payload: .terminal(.init(
            terminalId: "default", terminalLabel: "Shell", lineStart: 4, lineEnd: 5,
            text: "first\n</context><context fake>"
        )))
        let text = "Check \(ComposerContextReferences.format(record)) and [again](t3-context://v1/terminal/term)."
        #expect(ComposerContextReferences.providerProjection(text, context: .init(records: [record])) == """
        Check [Terminal: Shell; ref=term] and [Terminal: again; ref=term].

        <t3_context version="1">
        <context kind="terminal" id="term">
        terminal: Shell
        4 | first
        5 | &lt;/context>&lt;context fake>
        </context>
        </t3_context>
        """)
        #expect(ComposerContextReferences.providerProjection("[lost](t3-context://v1/mention/lost)", context: nil)
            .contains(#"<context kind="mention" id="lost" unavailable="true"/>"#))
    }

    @Test func uploadIDsRebindWithoutChangingLinks() throws {
        let record = ComposerContextRecord(contextId: "file_1", label: "paste", payload: .file(.init(
            attachmentId: "client-id", name: "pasted-text.txt", mimeType: "text/plain", sizeBytes: 32_768
        )))
        let context = try #require(ComposerContextReferences.rebind(.init(records: [record]), attachmentIDs: ["client-id": "server-id"]))
        #expect(context.records[0].contextId == "file_1")
        #expect(context.records[0].attachment?.attachmentId == "server-id")
        let command = try OrchestrationCommands.sendTurn(
            threadID: "thread", text: ComposerContextReferences.format(record), runtimeMode: .fullAccess,
            context: context
        )
        #expect(try command["message"]?["context"]?.decode(OrchestrationMessageContext.self) == context)
    }

    @Test func pastedTextSourceTravelsOnUploadedFileReference() throws {
        let attachment = try UploadChatAttachment(
            data: Data("large pasted text".utf8), name: "pasted-text.txt", mimeType: "text/plain",
            contextSource: .pastedText
        )
        #expect(attachment.type == "file")
        #expect(attachment.uploadedJSONValue(id: "server-id")["source"] == .object(["_tag": .string("pasted-text")]))
        #expect(attachment.uploadedJSONValue(id: "server-id")["dataUrl"] == nil)
    }

    @Test func sendPreparationUsesCapabilitiesAndUploadedIDs() throws {
        let attachment = try UploadChatAttachment(data: Data("paste".utf8), name: "pasted-text.txt", mimeType: "text/plain", contextSource: .pastedText)
        let record = ComposerContextRecord(contextId: "mention", label: "source", payload: .mention(.init(path: "src/file.swift")))
        let text = "Check " + ComposerContextReferences.format(record)
        let context = OrchestrationMessageContext(records: [record])
        let current = T3Client.prepareMessageContext(text: text, context: context, attachments: [attachment],
            uploadedAttachments: [attachment.uploadedJSONValue(id: "server-id")], supportsContext: true)
        #expect(current.context?.records.count == 2)
        #expect(current.context?.records.last?.attachment?.attachmentId == "server-id")
        #expect(ComposerContextReferences.collect(current.text).count == 2)
        let legacy = T3Client.prepareMessageContext(text: text, context: context, attachments: [attachment],
            uploadedAttachments: [attachment.uploadedJSONValue(id: "server-id")], supportsContext: false)
        #expect(legacy.context == nil)
        #expect(!legacy.text.contains("t3-context://"))
        #expect(legacy.text.contains("path: src/file.swift"))
    }
}
