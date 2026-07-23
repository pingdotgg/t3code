import Foundation
import Testing

@testable import T3Kit

@Suite("Asset URL helpers")
struct AssetRpcTests {
    @Test func resolveAssetURLJoinsRelativePath() {
        let base = URL(string: "http://127.0.0.1:3773")!
        let resolved = resolveAssetURL(
            httpBaseURL: base,
            relativeUrl: "/api/assets/token/photo.png")
        #expect(resolved?.absoluteString == "http://127.0.0.1:3773/api/assets/token/photo.png")
    }

    @Test func attachmentResourceEncodesTaggedStruct() throws {
        let input = AssetCreateUrlInput(attachmentId: "thread-1-image-1")
        let data = try JSONEncoder().encode(input)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let resource = object?["resource"] as? [String: Any]
        #expect(resource?["_tag"] as? String == "attachment")
        #expect(resource?["attachmentId"] as? String == "thread-1-image-1")
    }

    @Test func createUrlResultDecodesExpiresAt() throws {
        let json = """
            {"relativeUrl":"/api/assets/abc/x.png","expiresAt":1.721e12}
            """.data(using: .utf8)!
        let result = try JSONDecoder().decode(AssetCreateUrlResult.self, from: json)
        #expect(result.relativeUrl == "/api/assets/abc/x.png")
        #expect(result.expiresAt == 1.721e12)
    }
}
