import Foundation

struct NativeLicense: Decodable, Identifiable {
    struct Notice: Decodable {
        let sourceURL: URL
        let text: String
    }

    let name: String
    let version: String
    let notices: [Notice]
    var id: String { name }

    var versionLabel: String {
        version.count == 40 && version.allSatisfy(\.isHexDigit)
            ? String(version.prefix(12)) : version
    }
}

enum NativeLicenseCatalog {
    /// These notices ship in the app so they remain available without an environment.
    static func load(bundle: Bundle = .main) throws -> [NativeLicense] {
        guard let url = bundle.url(forResource: "NativeLicenses", withExtension: "json") else {
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode([NativeLicense].self, from: Data(contentsOf: url))
    }
}
