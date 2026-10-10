import Foundation

/// Formats the original item, never the shortened work-log label.
enum FeatureV2ItemDetail {
    @MainActor static func answers(_ raw: JSONValue, source: OrchestrationV2TimelineMetadata) -> [FeatureMessage] {
        guard let answer = raw["questionAnswer"] else { return [] }
        var fields = answer.v2Object
        fields["attachmentsByQuestionId"] = fields["attachmentsByQuestionId"] ?? .object([:])
        fields["questionTextById"] = fields["questionTextById"] ?? .object([:])
        let activity = OrchestrationActivity(id: source.projectedID, tone: "info", kind: "user-input.answer-submitted",
            summary: "Question answered", payload: .object(fields), turnId: source.runID,
            sequence: nil, createdAt: source.updatedAt)
        return NativeQuestionAnswerHistory.messages(activity, createdAt: NativeTimestampParser.parse(source.updatedAt) ?? .distantPast)
    }

    static func needsFetch(_ raw: JSONValue) -> Bool {
        switch raw["type"]?.stringValue {
        case "command_execution": return raw["outputOmitted"]?.boolValue == true
        case "dynamic_tool":
            return raw["outputOmitted"]?.boolValue == true
                || (raw["input"]?["truncated"]?.boolValue == true && raw["input"]?["summary"]?.stringValue != nil)
        default: return false
        }
    }

    static func call(_ raw: JSONValue) -> String? {
        switch raw["type"]?.stringValue {
        case "command_execution": return nonempty(raw["input"]?.stringValue)
        case "dynamic_tool":
            guard let input = raw["input"] else { return nil }
            if case let .object(fields) = input, input["truncated"]?.boolValue != true {
                return nonempty(fields.keys.sorted().map { key in
                    let value = fields[key] ?? .null
                    let text = value.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? json(value)
                    return "\(key): \(text)"
                }.joined(separator: "\n"))
            }
            return valueText(input)
        case "file_search": return nonempty(raw["pattern"]?.stringValue)
        case "web_search": return nonempty(raw["patterns"]?.v2Array?.compactMap(\.stringValue).joined(separator: "\n"))
        default: return nil
        }
    }

    static func output(_ raw: JSONValue) -> String? {
        guard raw["outputOmitted"]?.boolValue != true else { return nil }
        switch raw["type"]?.stringValue {
        case "command_execution":
            guard let output = nonempty(raw["output"]?.stringValue) else { return nil }
            if let parsed = parse(output), let stdout = parsed["stdout"]?.stringValue,
               let stderr = parsed["stderr"]?.stringValue, parsed["interrupted"]?.boolValue != nil {
                return nonempty([stdout, stderr].filter { !$0.isEmpty }.joined(separator: "\n"))
            }
            return output
        case "dynamic_tool": return raw["output"].flatMap { valueText(FeatureToolOutputImages.textOutput($0)) }
        case "file_search":
            return nonempty(raw["results"]?.v2Array?.map { result in
                let location = (result["fileName"]?.stringValue ?? "")
                    + (result["line"]?.v2Int.map { ":\($0)" } ?? "")
                return [location, result["preview"]?.stringValue].compactMap { $0 }.joined(separator: "\n")
            }.joined(separator: "\n"))
        case "web_search":
            return nonempty(raw["results"]?.v2Array?.map { result in
                [result["title"]?.stringValue, result["url"]?.stringValue, result["snippet"]?.stringValue]
                    .compactMap(nonempty).joined(separator: "\n")
            }.joined(separator: "\n\n"))
        default: return nil
        }
    }

    static func body(_ raw: JSONValue) -> String? {
        switch raw["type"]?.stringValue {
        case "command_execution", "dynamic_tool", "file_search", "web_search": return nil
        case "secret_request":
            return [raw["label"]?.stringValue, raw["reason"]?.stringValue, raw["secretStatus"]?.stringValue]
                .compactMap(nonempty).joined(separator: "\n")
        case "reasoning": return nonempty(raw["text"]?.stringValue)
        case "error":
            return [raw["failure"]?["message"]?.stringValue,
                    raw["retry"].map { "Retry: \(json($0))" }].compactMap(nonempty).joined(separator: "\n\n")
        case "approval_request": return nonempty(raw["prompt"]?.stringValue)
        case "user_input_request":
            return nonempty(raw["questions"]?.v2Array?.map {
                let choices = $0["options"]?.v2Array?.compactMap { $0["label"]?.stringValue }.joined(separator: ", ")
                return [$0["question"]?.stringValue, nonempty(choices)].compactMap { $0 }.joined(separator: "\n")
            }.joined(separator: "\n\n"))
        case "notification": return nonempty(raw["detail"]?.stringValue ?? raw["summary"]?.stringValue)
        case "system_notice", "run_interrupt_result": return nonempty(raw["message"]?.stringValue)
        case "proposed_plan": return nonempty(raw["markdown"]?.stringValue)
        case "compaction", "handoff": return nonempty(raw["summary"]?.stringValue)
        default:
            var fields = raw.v2Object
            // Match the shipped RN generic inspection path for normal file changes.
            if raw["type"]?.stringValue == "file_change" {
                fields.removeValue(forKey: "diffStr")
                fields.removeValue(forKey: "oldStr")
                fields.removeValue(forKey: "newStr")
            }
            return valueText(.object(fields))
        }
    }

    static func indicatesFailure(_ raw: JSONValue) -> Bool {
        let status = raw["status"]?.stringValue
        if ["failed", "declined"].contains(status ?? "") { return true }
        if raw["type"]?.stringValue == "error" { return false }
        if let code = raw["exitCode"]?.v2Int, code != 0 { return true }
        if raw["outputIndicatesFailure"]?.boolValue == true { return true }
        if resultIndicatesFailure(raw["output"], depth: 0) { return true }
        if raw["type"]?.stringValue == "command_execution", let output = raw["output"]?.stringValue {
            let prefix = String(output.prefix(32_768))
            let pattern = #"(?i)file not found|no files found|enoent|no such file|commandnotfoundexception|command not found|exit(?:ed)? with exit code\s+[1-9]\d*|exit code\s*[:\s]\s*[1-9]\d*\b"#
            if prefix.range(of: pattern, options: .regularExpression) != nil { return true }
        }
        if raw["type"]?.stringValue == "notification" { return raw["outcome"]?.stringValue == "failed" }
        return false
    }

    private static func resultIndicatesFailure(_ value: JSONValue?, depth: Int) -> Bool {
        guard let value, depth <= 4 else { return false }
        if let text = value.stringValue {
            guard text.utf8.count <= 32_768 else { return false }
            return resultIndicatesFailure(parse(text), depth: depth + 1)
        }
        if case let .array(values) = value {
            return values.contains { resultIndicatesFailure($0["text"] ?? $0["content"]?["text"], depth: depth + 1) }
        }
        if value["isError"]?.boolValue == true || value["is_error"]?.boolValue == true || value["success"]?.boolValue == false { return true }
        if let error = value["error"], error != .null { return true }
        if let tag = value["_tag"]?.stringValue, tag.hasSuffix("Error") || tag.hasSuffix("Failure") { return true }
        return resultIndicatesFailure(value["structuredContent"] ?? value["content"], depth: depth + 1)
    }

    static func copyText(_ raw: JSONValue) -> String {
        [call(raw), output(raw), body(raw), exitLabel(raw)].compactMap(nonempty).joined(separator: "\n\n")
    }

    static func exitLabel(_ raw: JSONValue) -> String? {
        raw["type"]?.stringValue == "secret_request" ? nil : raw["exitCode"]?.v2Int.flatMap { $0 == 0 ? nil : "Exit code: \($0)" }
    }

    static func valueText(_ value: JSONValue?) -> String? {
        guard let value, value != .null else { return nil }
        if let text = textBlocks(value, depth: 0) { return nonempty(prettyText(text)) }
        if value == .object([:]) || value == .array([]) { return nil }
        return json(value)
    }

    private static func textBlocks(_ value: JSONValue, depth: Int) -> String? {
        guard depth <= 4 else { return nil }
        switch value {
        case let .string(text): return text
        case let .array(values):
            let text = values.compactMap { textBlocks($0, depth: depth + 1) }
            return text.count == values.count ? text.joined(separator: "\n") : nil
        case let .object(fields):
            if fields["type"] == .string("text") { return fields["text"]?.stringValue }
            if fields["type"] == .string("image") { return "[image]" }
            if fields["type"] == .string("resource_link") { return fields["uri"]?.stringValue }
            if fields["type"] == .string("resource") {
                return fields["resource"]?["text"]?.stringValue ?? fields["resource"]?["uri"]?.stringValue
            }
            let keys = Set(fields.keys).subtracting(["isError", "is_error"])
            if keys == ["content"] || keys == ["content", "structuredContent"], let content = fields["content"] {
                return textBlocks(content, depth: depth + 1)
            }
            return nil
        default: return nil
        }
    }

    private static func prettyText(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.first == "{" || trimmed.first == "[" else { return text }
        if let value = parse(trimmed) { return json(value) }
        let lines = trimmed.split(separator: "\n").map(String.init)
        let values = lines.compactMap(parse)
        return values.count == lines.count ? values.map(json).joined(separator: "\n\n") : text
    }

    static func nonempty(_ text: String?) -> String? {
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return text
    }

    private static func parse(_ text: String) -> JSONValue? {
        try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    private static func json(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
}


struct FeatureV2FormattedItem: Sendable {
    let call: String?
    let output: String?
    let body: String?
    let exitLabel: String?

    init(raw: JSONValue) {
        call = FeatureV2ItemDetail.call(raw)
        output = FeatureV2ItemDetail.output(raw)
        body = FeatureV2ItemDetail.body(raw)
        exitLabel = FeatureV2ItemDetail.exitLabel(raw)
    }

    var copyText: String {
        [call, output, body, exitLabel].compactMap(FeatureV2ItemDetail.nonempty).joined(separator: "\n\n")
    }
}
