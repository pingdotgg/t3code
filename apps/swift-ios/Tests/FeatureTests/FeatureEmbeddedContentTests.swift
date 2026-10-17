import Combine
import Foundation
import XCTest
@testable import T3Code

@MainActor
final class FeatureEmbeddedContentTests: XCTestCase {
    func testCompletedHTMLRecognitionUsesT3NamespaceAndBoundedLegacyEnvelopes() throws {
        for name in ["html_render", "mcp__t3-code__html_render", "t3_code.html_render", "t3-code · html_render", "t3-code-thread_42_html_render"] {
            XCTAssertNotNil(FeatureEmbeddedContent.reference(raw: row(name: name, output: html)))
        }
        XCTAssertNil(FeatureEmbeddedContent.reference(raw: row(name: "other.html_render", output: html)))
        XCTAssertNil(FeatureEmbeddedContent.reference(raw: row(name: "html_render", output: html, status: "running")))
        XCTAssertNil(FeatureEmbeddedContent.reference(raw: row(name: "html_render", output: html, status: "failed")))
        let text = String(decoding: try JSONEncoder().encode(html), as: UTF8.self)
        let envelope: JSONValue = .object(["content": .array([.object(["type": .string("text"), "text": .string(text)])])])
        XCTAssertNotNil(FeatureEmbeddedContent.reference(raw: row(name: "html_render", output: envelope)))
        let failed: JSONValue = .object(["isError": .bool(true), "content": .array([.object(["text": .string(text)])])])
        XCTAssertNil(FeatureEmbeddedContent.reference(raw: row(name: "html_render", output: failed)))
        var deep = html
        for _ in 0..<6 { deep = .object(["structuredContent": deep]) }
        XCTAssertNil(FeatureEmbeddedContent.reference(raw: row(name: "html_render", output: deep)))
    }

    func testMCPRequiresMatchingToolAndPreservesErrorResults() {
        let app: JSONValue = .object(["attachmentId": .string("app"), "server": .string("charts"),
                                      "tool": .string("draw"), "resourceUri": .string("ui://charts/draw")])
        let output: JSONValue = .object(["t3McpApp": app, "isError": .bool(true)])
        XCTAssertNotNil(FeatureEmbeddedContent.reference(raw: row(name: "charts.draw", output: output)))
        XCTAssertNil(FeatureEmbeddedContent.reference(raw: row(name: "other.draw", output: output)))
        var invalid = app.v2Object; invalid["resourceUri"] = .string("https://example.com")
        XCTAssertNil(FeatureEmbeddedContent.reference(raw: row(name: "charts.draw", output: .object(["t3McpApp": .object(invalid)]))))
    }

    func testResponsiveHeightOnlyCapsExplicitScrollingFrames() {
        let measurements: [FeatureHTMLReference.Measurement] = [.init(width: 320, height: 900), .init(width: 430, height: 650), .init(width: 728, height: 400)]
        let responsive = FeatureHTMLReference(attachmentID: "a", title: "Page", height: 400, heights: measurements)
        XCTAssertEqual(responsive.frameHeight(width: 320), 900)
        XCTAssertEqual(responsive.frameHeight(width: 375), 900)
        XCTAssertEqual(responsive.frameHeight(width: 430), 650)
        XCTAssertEqual(responsive.frameHeight(width: 728), 400)
        let capped = FeatureHTMLReference(attachmentID: "a", title: "Page", height: 300, heights: measurements)
        XCTAssertEqual(capped.frameHeight(width: 375), 300)
        let unknown = FeatureHTMLReference(attachmentID: "a", title: "Page", height: 400, heights: [])
        XCTAssertEqual(unknown.frameHeight(width: 375, contentHeight: 200), 200)
        XCTAssertEqual(unknown.frameHeight(width: 375, contentHeight: 900), 400)
        XCTAssertEqual(FeatureHTMLReference.clamp(-10), 80)
        XCTAssertEqual(FeatureHTMLReference.clamp(9000), 2000)
    }

    func testBridgeRejectsSubframeStaleAndUnknownOperations() {
        func accepts(_ main: Bool = true, _ token: String = "current", _ operation: String = "callTool", _ bytes: Int = 100) -> Bool {
            FeatureEmbeddedContentController.acceptsBridge(isMainFrame: main, documentID: token, expectedID: "current", operation: operation, byteCount: bytes)
        }
        XCTAssertTrue(accepts())
        XCTAssertFalse(accepts(false))
        XCTAssertFalse(accepts(true, "previous"))
        XCTAssertFalse(accepts(true, "current", "rawRpc"))
        XCTAssertFalse(accepts(true, "current", "callTool", 256 * 1024 + 1))
        XCTAssertNil(FeatureEmbeddedContentController.externalURL("javascript:alert(1)"))
        XCTAssertNil(FeatureEmbeddedContentController.externalURL("file:///private/data"))
    }

    func testSignedAssetRefreshesBeforeItsExpiryForANewDocument() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let url = try XCTUnwrap(URL(string: "https://example.com/api/assets/page?token=signed"))
        for remaining in [-1.0, 0, 59, 60] {
            let asset = ResolvedAssetURL(url: url, expiresAt: now.addingTimeInterval(remaining))
            XCTAssertFalse(FeatureEmbeddedContentController.canReuseAsset(asset, now: now))
        }
        let fresh = ResolvedAssetURL(url: url, expiresAt: now.addingTimeInterval(61))
        XCTAssertTrue(FeatureEmbeddedContentController.canReuseAsset(fresh, now: now))
        XCTAssertFalse(FeatureEmbeddedContentController.canReuseAsset(fresh, now: now.addingTimeInterval(1)))
    }

    func testHTTPFailuresIncludeTheMCPAssetIframeAndHTMLMainDocument() throws {
        let asset = try XCTUnwrap(URL(string: "https://example.com/api/assets/page?token=signed"))
        let themed = try XCTUnwrap(URL(string: asset.absoluteString + "#t3-theme=dark"))
        for status in [200, 204, 299, 300, 401, 403, 404, 500] {
            let response = try XCTUnwrap(HTTPURLResponse(url: themed, statusCode: status, httpVersion: nil, headerFields: nil))
            for mainFrame in [true, false] {
                XCTAssertEqual(FeatureEmbeddedContentController.isFailedDocumentResponse(
                    response, isMainFrame: mainFrame, assetURL: asset), status >= 300)
            }
        }
        let host = URLResponse(url: try XCTUnwrap(URL(string: "about:blank")), mimeType: "text/html",
                               expectedContentLength: 0, textEncodingName: "utf-8")
        XCTAssertFalse(FeatureEmbeddedContentController.isFailedDocumentResponse(host, isMainFrame: true, assetURL: asset))
    }

    func testUnrelatedIframeFailuresDoNotRefreshTheSignedAsset() throws {
        let asset = try XCTUnwrap(URL(string: "https://example.com/api/assets/page?token=signed"))
        for address in ["https://example.com/api/assets/other?token=signed",
                        "https://example.com/api/assets/page?token=other",
                        "https://other.example.com/api/assets/page?token=signed"] {
            let url = try XCTUnwrap(URL(string: address))
            let response = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: 403,
                                                       httpVersion: nil, headerFields: nil))
            XCTAssertFalse(FeatureEmbeddedContentController.isFailedDocumentResponse(response, isMainFrame: false, assetURL: asset))
            XCTAssertFalse(FeatureEmbeddedContentController.isFailedDocumentResponse(response, isMainFrame: false, assetURL: nil))
            XCTAssertTrue(FeatureEmbeddedContentController.isFailedDocumentResponse(response, isMainFrame: true, assetURL: asset))
        }
    }

    func testReadOnlyToolSkipsConfirmationAndUsesSourceIdentity() async throws {
        let client = EmbeddedClient()
        let controller = try controller(client)
        _ = try await controller.handle(operation: "callTool", payload: .object(["name": .string("read"), "arguments": .object([:])]), token: controller.documentID)
        XCTAssertEqual(client.operations, [.toolInfo, .callTool])
        XCTAssertEqual(client.sources, ["source-thread", "source-thread"])
        XCTAssertEqual(client.conversations, ["displayed-thread", "displayed-thread"])
        XCTAssertNil(controller.confirmation)
    }

    func testDeclinedWriteNeverReachesCallTool() async throws {
        let client = EmbeddedClient(); client.readOnly = false
        let controller = try controller(client)
        let pending = expectation(description: "Write approval requested")
        let subscription = controller.$confirmation.dropFirst().sink { value in if value != nil { pending.fulfill() } }
        let request = Task {
            try await controller.handle(operation: "callTool", payload: .object(["name": .string("write"), "arguments": .object(["value": .string("changed")])]), token: controller.documentID)
        }
        await fulfillment(of: [pending], timeout: 2)
        controller.answerConfirmation(false)
        do { _ = try await request.value; XCTFail("Declined call succeeded") } catch {}
        XCTAssertEqual(client.operations, [.toolInfo])
        subscription.cancel()
    }

    func testContextUsesRPCAndApprovedMessageUsesConversationSend() async throws {
        let client = EmbeddedClient()
        var sent: [String] = []
        let controller = try controller(client, send: { sent.append($0) })
        _ = try await controller.handle(operation: "updateModelContext", payload: .object([:]), token: controller.documentID)
        XCTAssertEqual(client.operations, [.updateModelContext])
        XCTAssertTrue(sent.isEmpty)
        let pending = expectation(description: "Message approval requested")
        let subscription = controller.$confirmation.dropFirst().sink { value in if value != nil { pending.fulfill() } }
        let request = Task { try await controller.handle(operation: "sendMessage", payload: .object(["text": .string("hello")]), token: controller.documentID) }
        await fulfillment(of: [pending], timeout: 2)
        controller.answerConfirmation(true)
        _ = try await request.value
        XCTAssertEqual(sent, ["hello"])
        subscription.cancel()
        let oldToken = controller.documentID
        await controller.teardown()
        XCTAssertFalse(controller.isCurrent(oldToken))
    }

    private var html: JSONValue { .object(["htmlRender": .object(["attachmentId": .string("a"), "title": .string("Page"), "height": .number(400)])]) }
    private func row(name: String, output: JSONValue, status: String = "completed") -> JSONValue {
        .object(["type": .string("dynamic_tool"), "toolName": .string(name), "status": .string(status), "output": output])
    }
    private func controller(_ client: EmbeddedClient, send: @escaping @MainActor (String) async throws -> Void = { _ in }) throws -> FeatureEmbeddedContentController {
        let source = try JSONDecoder().decode(OrchestrationV2TimelineMetadata.self, from: Data("""
        {"projectedID":"p","sourceThreadID":"source-thread","itemID":"source-item","visibility":"inherited","position":1,"itemType":"dynamic_tool","status":"completed","updatedAt":"2026-10-07T00:00:00Z"}
        """.utf8))
        let raw = row(name: "html_render", output: html)
        return FeatureEmbeddedContentController(item: .init(source: source, raw: raw), reference: try XCTUnwrap(FeatureEmbeddedContent.reference(raw: raw)),
            context: .init(threadID: "displayed-thread", client: client, sendMessage: send, canEnterFullscreen: true))
    }
}

@MainActor
private final class EmbeddedClient: FeatureEmbeddedContentClient {
    var readOnly = true
    var operations: [FeatureMCPOperation] = []
    var sources: [String] = []
    var conversations: [String] = []
    func embeddedAsset(threadID: String, resource: AssetResource) async throws -> ResolvedAssetURL { throw CancellationError() }
    func embeddedItem(threadID: String, source: OrchestrationV2TimelineMetadata) async throws -> JSONValue { throw CancellationError() }
    func embeddedRequest(threadID: String, source: OrchestrationV2TimelineMetadata, operation: FeatureMCPOperation, payload: JSONValue) async throws -> JSONValue {
        operations.append(operation); sources.append(source.sourceThreadID); conversations.append(threadID)
        return .object(["callable": .bool(true), "readOnly": .bool(readOnly), "content": .array([])])
    }
}
