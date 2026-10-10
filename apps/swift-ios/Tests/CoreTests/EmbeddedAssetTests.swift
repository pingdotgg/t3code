import XCTest
@testable import T3Code

final class EmbeddedAssetTests: XCTestCase {
    func testScreenshotUsesSourceIdentityAndRecognizedImageIndex() {
        XCTAssertEqual(AssetResource.toolOutputImage(threadID: "source", itemID: "tool", index: 2).jsonValue,
            .object(["_tag": .string("tool-output-image"), "threadId": .string("source"), "itemId": .string("tool"), "index": .number(2)]))
    }
    func testInlineHTMLAssetKeepsSignedAssetDispositionExplicit() {
        let resource = AssetResource.attachment(id: "page", fileName: "Report.html", mimeType: "text/html", disposition: .inline).jsonValue
        XCTAssertEqual(resource["disposition"], .string("inline"))
        XCTAssertEqual(resource["attachmentId"], .string("page"))
        XCTAssertNil(AssetResource.attachment(id: "file").jsonValue["disposition"])
    }
}
