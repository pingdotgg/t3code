import Foundation

/// One photo from the Unsplash API, reduced to the fields the scenery system
/// needs. Persisted in `pool.json`, so keep the shape Codable-stable.
public struct SceneryPhoto: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    /// Evocative Dolomites display name paired with the photo when the pool
    /// is built (Unsplash alt text is machine-y; curated names read better).
    public var name: String
    /// Average color reported by Unsplash ("#RRGGBB"); wash while loading.
    public var averageColorHex: String?
    public var heroURL: URL
    public var thumbURL: URL
    /// Unprocessed base image (`urls.raw`); the store appends imgix sizing
    /// params to render heroes at the display's real pixel width. Optional
    /// because pools cached before this field existed lack it.
    public var rawURL: URL?
    /// Unsplash `links.download_location` — must be pinged once when the
    /// photo is actually used (API guideline).
    public var downloadLocationURL: URL?
    public var photographerName: String
    public var photographerProfileURL: URL?
}

/// Minimal Unsplash REST client (search + download registration + CDN image
/// fetch). Read-only public endpoints, so only the access key is needed —
/// never embed the secret key in the app.
public actor UnsplashClient {
    /// utm_source value Unsplash attribution links must carry.
    public static let appName = "SergeCode"

    private let accessKey: String
    private let session = URLSession.shared

    /// nil when no key is configured — callers degrade to gradient washes.
    public init?(accessKey: String? = UnsplashClient.resolveAccessKey()) {
        guard let accessKey, !accessKey.isEmpty else { return nil }
        self.accessKey = accessKey
    }

    /// Key lookup: `SERGECODE_UNSPLASH_KEY` env var, then
    /// `~/Library/Application Support/SergeCode/unsplash-access-key`.
    /// Deliberately never bundled or committed.
    public static func resolveAccessKey() -> String? {
        if let env = ProcessInfo.processInfo.environment["SERGECODE_UNSPLASH_KEY"],
            !env.isEmpty
        {
            return env
        }
        guard
            let support = FileManager.default.urls(
                for: .applicationSupportDirectory, in: .userDomainMask
            ).first
        else { return nil }
        let file = support.appendingPathComponent("SergeCode/unsplash-access-key")
        guard let raw = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        let key = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return key.isEmpty ? nil : key
    }

    // MARK: - Wire types (subset of the search response)

    struct SearchResponse: Decodable, Sendable {
        var results: [APIPhoto]
    }

    struct APIPhoto: Decodable, Sendable {
        struct URLs: Decodable, Sendable {
            var raw: URL
            var regular: URL
            var thumb: URL
        }
        struct Links: Decodable, Sendable {
            var downloadLocation: URL?
        }
        struct User: Decodable, Sendable {
            struct UserLinks: Decodable, Sendable {
                var html: URL?
            }
            var name: String
            var links: UserLinks?
        }

        var id: String
        var color: String?
        var urls: URLs
        var links: Links?
        var user: User
    }

    public enum UnsplashError: Error {
        case badStatus(Int)
    }

    func searchPhotos(query: String, count: Int) async throws -> [APIPhoto] {
        var components = URLComponents(string: "https://api.unsplash.com/search/photos")!
        components.queryItems = [
            URLQueryItem(name: "query", value: query),
            URLQueryItem(name: "per_page", value: String(count)),
            URLQueryItem(name: "orientation", value: "landscape"),
            URLQueryItem(name: "content_filter", value: "high"),
        ]
        var request = URLRequest(url: components.url!)
        request.setValue("Client-ID \(accessKey)", forHTTPHeaderField: "Authorization")
        request.setValue("v1", forHTTPHeaderField: "Accept-Version")
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw UnsplashError.badStatus(http.statusCode)
        }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(SearchResponse.self, from: data).results
    }

    /// Ping `links.download_location` — required by the Unsplash guidelines
    /// whenever a photo is put to use. Fire-and-forget; failures are benign.
    public func registerDownload(_ url: URL) async {
        var request = URLRequest(url: url)
        request.setValue("Client-ID \(accessKey)", forHTTPHeaderField: "Authorization")
        _ = try? await session.data(for: request)
    }

    /// Plain CDN fetch (images.unsplash.com needs no auth header).
    public func fetchImageData(from url: URL) async throws -> Data {
        let (data, response) = try await session.data(from: url)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw UnsplashError.badStatus(http.statusCode)
        }
        return data
    }
}
