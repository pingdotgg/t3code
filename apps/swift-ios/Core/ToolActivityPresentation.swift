import Foundation

public struct ToolNativeAppReference: Codable, Hashable, Sendable {
    public let _tag: String
    public let appId: String?
    public let displayName: String?
}

public struct ToolActivityPresentation: Codable, Hashable, Sendable {
    public let surface: String?
    public let sourceName: String?
    public let lightURL: URL?
    public let darkURL: URL?
    public let nativeApp: ToolNativeAppReference?

    init?(payload: JSONValue) {
        let source = payload["toolSource"]
        surface = payload["toolSurface"]?.stringValue ?? source?["kind"]?.stringValue
        sourceName = source?["name"]?.stringValue
        let icon = payload["toolIcon"] ?? source?["icon"]
        let kind = icon?["_tag"]?.stringValue
        lightURL = Self.imageURL(icon?[kind == "website" ? "faviconUrl" : "logoUrl"]?.stringValue)
        darkURL = Self.imageURL(icon?[kind == "website" ? "faviconUrlDark" : "logoUrlDark"]?.stringValue)
        if kind == "native-app", let app = icon?["app"] {
            if app["_tag"]?.stringValue == "app-id", let id = app["appId"]?.stringValue,
               !id.isEmpty, id.count <= 512, id.range(of: #"^[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil {
                nativeApp = ToolNativeAppReference(_tag: "app-id", appId: id, displayName: nil)
            } else if app["_tag"]?.stringValue == "display-name", let name = app["displayName"]?.stringValue,
                      !name.isEmpty, name.count <= 160 {
                nativeApp = ToolNativeAppReference(_tag: "display-name", appId: nil, displayName: name)
            } else { nativeApp = nil }
        } else { nativeApp = nil }
        if surface == nil, sourceName == nil, lightURL == nil, darkURL == nil, nativeApp == nil { return nil }
    }

    private static func imageURL(_ raw: String?) -> URL? {
        guard let raw, raw.count <= 4_096, let url = URL(string: raw),
              ["https", "http", "data"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        return url
    }
}
