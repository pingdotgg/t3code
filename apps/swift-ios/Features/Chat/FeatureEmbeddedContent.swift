import Foundation

struct FeatureHTMLReference: Equatable, Sendable {
    struct Measurement: Equatable, Sendable { let width: Double; let height: Double }
    let attachmentID: String
    let title: String
    let height: Double
    let heights: [Measurement]

    static func clamp(_ height: Double) -> Double { min(2000, max(80, height.rounded())) }

    func frameHeight(width: Double, contentHeight: Double? = nil) -> Double {
        guard !heights.isEmpty else { return Self.clamp(min(height, contentHeight ?? height)) }
        func measured(_ width: Double) -> Double {
            let high = heights.firstIndex { $0.width >= width } ?? heights.count - 1
            let low = heights[high].width == width ? high : max(0, high - 1)
            return max(heights[low].height, heights[high].height)
        }
        let cap = measured(728) > height ? height : 2000
        return Self.clamp(min(cap, contentHeight ?? measured(width)))
    }

    var fileName: String {
        let forbidden = CharacterSet(charactersIn: "\\/:*?\"<>|").union(.controlCharacters)
        let words = title.components(separatedBy: forbidden).joined(separator: " ")
            .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        let name = String(words.prefix(120)).trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(name.isEmpty ? "Page" : name).html"
    }
}

struct FeatureMCPReference: Equatable, Sendable {
    let attachmentID: String
    let server: String
    let tool: String
    let resourceURI: String
    let raw: JSONValue

    static func == (left: Self, right: Self) -> Bool {
        left.attachmentID == right.attachmentID && left.server == right.server
            && left.tool == right.tool && left.resourceURI == right.resourceURI
    }

    var fileName: String {
        let name = tool.replacingOccurrences(of: "[^a-zA-Z0-9_.-]+", with: "-", options: .regularExpression)
        return "\(name.isEmpty ? "app" : String(name.prefix(80))).html"
    }
}

enum FeatureEmbeddedContent: Equatable, Sendable {
    case html(FeatureHTMLReference)
    case mcp(FeatureMCPReference)

    var attachmentID: String {
        switch self { case .html(let page): page.attachmentID; case .mcp(let app): app.attachmentID }
    }
    var fileName: String {
        switch self { case .html(let page): page.fileName; case .mcp(let app): app.fileName }
    }

    /// Completed tool rows only. Bounded legacy envelopes follow the shared tool-output reader.
    static func reference(raw: JSONValue) -> Self? {
        guard raw["type"]?.stringValue == "dynamic_tool", raw["status"]?.stringValue == "completed",
              let name = raw["toolName"]?.stringValue, let output = raw["output"] else { return nil }
        var budget = EnvelopeBudget()
        let result = budget.read(output)
        guard !budget.exceeded, let data = result.data else { return nil }
        if isHTMLTool(name), !result.failed, let page = data["htmlRender"],
           let id = page["attachmentId"]?.stringValue, !id.isEmpty, id.count <= 256,
           let title = page["title"]?.stringValue, let height = page["height"]?.embeddedNumber, height.isFinite {
            var heights: [FeatureHTMLReference.Measurement] = []
            if case let .array(entries) = page["heights"], !entries.isEmpty, entries.count <= 24 {
                for entry in entries {
                    guard case let .array(pair) = entry, pair.count == 2,
                          let width = pair[0].embeddedNumber, width.rounded() == width, (1...10000).contains(width),
                          let measured = pair[1].embeddedNumber, measured.isFinite else { heights = []; break }
                    heights.append(.init(width: width, height: FeatureHTMLReference.clamp(measured)))
                }
            }
            let title = String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
            return .html(.init(attachmentID: id, title: title.isEmpty ? "HTML" : title,
                               height: FeatureHTMLReference.clamp(height), heights: heights.sorted { $0.width < $1.width }))
        }
        if let app = data["t3McpApp"], let id = boundedName(app["attachmentId"]),
           let server = boundedName(app["server"]), let tool = boundedName(app["tool"]),
           name == "\(server).\(tool)", let uri = app["resourceUri"]?.stringValue,
           uri.hasPrefix("ui://"), uri.count <= 4096 {
            return .mcp(.init(attachmentID: id, server: server, tool: tool, resourceURI: uri, raw: app))
        }
        return nil
    }

    private static func boundedName(_ value: JSONValue?) -> String? {
        guard let text = value?.stringValue, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.count <= 256 else { return nil }
        return text
    }

    private static func isHTMLTool(_ name: String) -> Bool {
        let name = name.replacingOccurrences(of: "\\s+(?:complete|completed)\\s*$", with: "", options: [.regularExpression, .caseInsensitive])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if name == "html_render" { return true }
        for pattern in [
            "(?i)^mcp__(?:t3-code|t3_code|t3code)__html_render$",
            "(?i)^(?:t3-code|t3_code|t3code)(?:[.:/]|\\s*·\\s*)html_render$",
            "(?i)^(?:mcp[-_]{1,2})?t3[-_ ]?code(?:__|[-_.:/ ])html_render$",
            "(?i)^t3-code-.+_html_render$",
        ] where name.range(of: pattern, options: .regularExpression) != nil { return true }
        return false
    }
}

private struct EnvelopeBudget {
    var bytes = 16384
    var nodes = 128
    var exceeded = false

    mutating func read(_ value: JSONValue, depth: Int = 0) -> (data: JSONValue?, failed: Bool) {
        nodes -= 1
        guard depth <= 4, nodes >= 0 else { exceeded = true; return (nil, false) }
        if case let .string(text) = value {
            bytes -= text.utf8.count
            guard bytes >= 0 else { exceeded = true; return (nil, false) }
            guard let parsed = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else { return (nil, false) }
            return read(parsed, depth: depth + 1)
        }
        if case let .array(blocks) = value {
            guard blocks.count <= 32 else { exceeded = true; return (nil, false) }
            var result: (data: JSONValue?, failed: Bool) = (nil, false)
            for block in blocks {
                let text = block["text"] ?? .null
                let next = read(text["text"] ?? text, depth: depth + 1)
                result = (result.data ?? next.data, result.failed || next.failed)
                if exceeded { break }
            }
            return result
        }
        guard case .object = value else { return (nil, false) }
        let failed = value["isError"]?.boolValue == true || value["is_error"]?.boolValue == true
            || value["_tag"]?.stringValue == "OrchestratorMcpFailure"
            || (value["error"] != nil && value["error"] != .null)
        if let content = value["structuredContent"].flatMap({ $0 == .null ? nil : $0 }) ?? value["content"] {
            let nested = read(content, depth: depth + 1)
            return (nested.data, failed || nested.failed)
        }
        return (value, failed)
    }
}

extension JSONValue {
    var embeddedNumber: Double? {
        switch self { case .number(let value): value; case .integer(let value): Double(value)
        case .unsignedInteger(let value): Double(value); default: nil }
    }
}

@MainActor
protocol FeatureEmbeddedContentClient: AnyObject {
    func embeddedAsset(threadID: String, resource: AssetResource) async throws -> ResolvedAssetURL
    func embeddedItem(threadID: String, source: OrchestrationV2TimelineMetadata) async throws -> JSONValue
    func embeddedRequest(threadID: String, source: OrchestrationV2TimelineMetadata,
                         operation: FeatureMCPOperation, payload: JSONValue) async throws -> JSONValue
}

enum FeatureMCPOperation: String, Sendable {
    case toolInfo, callTool, readResource, updateModelContext
}

@MainActor
struct FeatureEmbeddedContentContext {
    let threadID: String
    let client: any FeatureEmbeddedContentClient
    let sendMessage: @MainActor (String) async throws -> Void
    var canEnterFullscreen: Bool
}
