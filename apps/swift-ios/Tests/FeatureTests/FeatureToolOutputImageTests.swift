import Foundation
import XCTest
import UIKit
@testable import T3Code

final class FeatureToolOutputImageTests: XCTestCase {
    func testDenseIndexesAcrossTextUnsupportedAndAnthropicBlocks() {
        let raw = tool(.object(["content": .array([
            text("Before"), image("IMAGE/PNG"), text("Between"), image("image/svg+xml"),
            .object(["type": .string("image"), "source": .object(["type": .string("base64"), "media_type": .string("image/webp")])]),
            .object(["type": .string("image"), "mimeType": .string("image/png"), "source": .object(["type": .string("url")])]),
            image("image/jpeg"),
        ])]))
        XCTAssertEqual(FeatureToolOutputImages.images(raw), [
            .init(index: 0, mimeType: "image/png"), .init(index: 1, mimeType: "image/webp"), .init(index: 2, mimeType: "image/jpeg"),
        ])
        let output = FeatureV2ItemDetail.output(raw)
        XCTAssertTrue(output?.contains("Before") == true)
        XCTAssertTrue(output?.contains("Between") == true)
        XCTAssertEqual(output?.components(separatedBy: "[image]").count, 3)
    }

    func testSingleAndArrayMarkersRenderWithoutTextPlaceholderOrNoOutput() {
        for output in [image("image/gif"), .array([image("image/gif")]), .object(["content": .array([image("image/gif")])])] {
            XCTAssertEqual(FeatureToolOutputImages.images(tool(output)).count, 1)
            XCTAssertNil(FeatureV2ItemDetail.output(tool(output)))
        }
    }

    func testOnlyEightTopLevelImagesAreAccessibleAndOmittedFeedDoesNotLoad() {
        let output = JSONValue.array((0..<12).flatMap { _ in [text("Frame"), image("image/png")] })
        let raw = tool(output)
        XCTAssertEqual(FeatureToolOutputImages.images(raw).map(\.index), Array(0..<8))
        XCTAssertTrue(FeatureToolOutputImages.images(V2Fixture.patch(raw, ["outputOmitted": .bool(true)])).isEmpty)
        XCTAssertTrue(FeatureToolOutputImages.images(tool(.object(["nested": .array([image("image/png")])]))).isEmpty)
        XCTAssertTrue(FeatureToolOutputImages.images(tool(image("text/html"))).isEmpty)
        XCTAssertEqual(FeatureToolOutputImages.images(tool(.array([image("image/png"), image("image/jpeg")]))).count, 2)
    }

    func testToolImageAssetPreservesInheritedSourceIDsAndDenseIndex() throws {
        let resource = AssetResource.toolOutputImage(threadID: "original/thread", itemID: "original/item", index: 1)
        let encoded = resource.jsonValue
        XCTAssertEqual(encoded, .object([
            "_tag": .string("tool-output-image"), "threadId": .string("original/thread"),
            "itemId": .string("original/item"), "index": .number(1),
        ]))
    }

    @MainActor
    func testImageLoadingIsLazyAndRefreshesExpiredSignedURLOnce() async throws {
        let loader = FeatureToolOutputImageLoader()
        var resolutions = 0
        let data = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).pngData { context in
            UIColor.white.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        }
        XCTAssertNil(loader.image)
        XCTAssertEqual(resolutions, 0)
        let resolve = {
            resolutions += 1
            return URL(string: "https://assets.example/image?attempt=\(resolutions)")!
        }
        await loader.load(resolve: resolve, fetch: { url in
            let status = url.query == "attempt=1" ? 403 : 200
            return (data, HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
        })
        XCTAssertEqual(resolutions, 2)
        XCTAssertNotNil(loader.image)
        XCTAssertFalse(loader.failed)
        await loader.load(resolve: resolve)
        XCTAssertEqual(resolutions, 2)
    }

    @MainActor
    func testImageFailureStopsAfterOneAutomaticRetry() async {
        let loader = FeatureToolOutputImageLoader()
        var resolutions = 0
        await loader.load(resolve: {
            resolutions += 1
            return URL(string: "https://assets.example/missing")!
        }, fetch: { _ in throw RPCError.disconnected })
        XCTAssertEqual(resolutions, 2)
        XCTAssertTrue(loader.failed)
        XCTAssertNil(loader.image)
    }

    private func tool(_ output: JSONValue) -> JSONValue { .object(["type": .string("dynamic_tool"), "output": output]) }
    private func image(_ mime: String) -> JSONValue { .object(["type": .string("image"), "mimeType": .string(mime)]) }
    private func text(_ value: String) -> JSONValue { .object(["type": .string("text"), "text": .string(value)]) }
}
