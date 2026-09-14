import Foundation
import Testing
@testable import T3Code

@Suite("Native work log accumulator")
struct NativeWorkLogAccumulatorTests {
    @Test
    func lifecycleUpdatesReplaceActiveWorkAndCompletionAddsOneLine() {
        var accumulator = NativeWorkLogAccumulator()
        accumulator.append(
            activity(
                id: "started",
                kind: "tool.started",
                summary: "Run tests",
                payload: ["toolCallId": .string("call-1"), "title": .string("Run tests")]
            ),
            preview: nil,
            createdAt: Date(timeIntervalSince1970: 1)
        )
        accumulator.append(
            activity(
                id: "updated",
                kind: "tool.updated",
                summary: "Run focused tests",
                payload: [
                    "data": .object(["toolCallId": .string("call-1")]),
                    "title": .string("Run focused tests"),
                ]
            ),
            preview: nil,
            createdAt: Date(timeIntervalSince1970: 2)
        )

        var message = accumulator.message(groupID: "turn-1")
        #expect(message.activeWorkLabel == "Run focused tests")
        #expect(message.text.isEmpty)

        accumulator.append(
            activity(
                id: "completed",
                kind: "tool.completed",
                summary: "Run focused tests completed",
                payload: ["toolCallId": .string("call-1")]
            ),
            preview: "2 tests passed",
            createdAt: Date(timeIntervalSince1970: 3)
        )
        message = accumulator.message(groupID: "turn-1")
        #expect(message.activeWorkLabel == nil)
        #expect(message.toolName == "Work log · 1")
        #expect(message.text == "• 2 tests passed")
    }

    @Test
    func fallbackLifecycleMatchAndTurnEndClearActiveWork() {
        var accumulator = NativeWorkLogAccumulator()
        accumulator.append(
            activity(
                id: "started",
                kind: "tool.started",
                summary: "Read file",
                payload: [
                    "itemType": .string("dynamic_tool_call"),
                    "title": .string("Read file"),
                    "detail": .string("/tmp/screenshot.png"),
                ]
            ),
            preview: nil,
            createdAt: .now
        )
        accumulator.append(
            activity(
                id: "completed",
                kind: "tool.completed",
                summary: "Read file completed",
                payload: [
                    "itemType": .string("dynamic_tool_call"),
                    "title": .string("Read file completed"),
                    "detail": .string("/tmp/screenshot.png"),
                ]
            ),
            preview: "/tmp/screenshot.png",
            createdAt: .now
        )
        #expect(!accumulator.hasActiveWork)

        accumulator.append(
            activity(id: "next", kind: "tool.started", summary: "Old task"),
            preview: nil,
            createdAt: .now
        )
        accumulator.clearActiveWork()
        #expect(accumulator.message(groupID: "turn-1").activeWorkLabel == nil)
    }

    @Test
    func viewedImagesExcludeMultilineAndNonImageDetails() {
        var accumulator = NativeWorkLogAccumulator()
        for (id, detail) in [
            ("image", "/tmp/image one.PNG"),
            ("multiline", "/tmp/image.png\nextra"),
            ("text", "/tmp/readme.txt"),
        ] {
            accumulator.append(
                activity(
                    id: id,
                    kind: "tool.completed",
                    summary: "Read file",
                    payload: [
                        "requestKind": .string("file-read"),
                        "detail": .string(detail),
                    ]
                ),
                preview: detail,
                createdAt: .now
            )
        }
        #expect(accumulator.message(groupID: "turn-1").workLogImagePaths == [
            "/tmp/image one.PNG",
        ])
    }

    @Test
    func mediaRendersOnlyWhileExpandedAndEscapesMarkdownPaths() {
        let paths = ["/tmp/image one(2).png"]
        #expect(!FeatureWorkLogMedia.shouldRenderImages(isExpanded: false, paths: paths))
        #expect(FeatureWorkLogMedia.shouldRenderImages(isExpanded: true, paths: paths))
        #expect(FeatureWorkLogMedia.markdownSource(for: paths) == "![](/tmp/image%20one%282%29.png)")
    }

    private func activity(
        id: String,
        kind: String,
        summary: String,
        payload: [String: JSONValue] = [:]
    ) -> OrchestrationActivity {
        OrchestrationActivity(
            id: id,
            tone: "info",
            kind: kind,
            summary: summary,
            payload: .object(payload),
            turnId: "turn-1",
            sequence: nil,
            createdAt: "2026-09-01T00:00:00Z"
        )
    }
}
