import AppKit
import SwiftUI

/// Serializes access to the vendored JavaScript highlighter and keeps recent
/// code blocks ready for SwiftUI to render without re-entering JavaScript.
actor CodeHighlighter {
    static let shared = CodeHighlighter()

    private struct CacheKey: Hashable, Sendable {
        let code: String
        let language: String
        let dark: Bool
    }

    private let highlighter = Highlight()
    private let cacheCapacity = 256
    private var cache: [CacheKey: AttributedString] = [:]
    private var mostRecentlyUsed: [CacheKey] = []
    private var didWarm = false

    /// Highlights a fenced code block when its language is explicitly
    /// supported. Unknown and plaintext fences intentionally stay on the
    /// caller's plain-text path instead of invoking highlight.js detection.
    func highlighted(code: String, language: String?, dark: Bool) async -> AttributedString? {
        guard let mappedLanguage = Self.mappedLanguage(for: language) else { return nil }

        let key = CacheKey(code: code, language: mappedLanguage, dark: dark)
        if let cached = cache[key] {
            touch(key)
            return cached
        }

        do {
            let result = try await highlighter.request(
                code,
                mode: .languageAlias(mappedLanguage),
                colors: dark ? .dark(.xcode) : .light(.xcode))
            guard !result.isUndefined, !Task.isCancelled else { return nil }

            let attributedText = swiftUIAttributedText(from: result.attributedText)
            insert(attributedText, for: key)
            return attributedText
        } catch {
            return nil
        }
    }

    /// Loads highlight.js into its JavaScriptCore context during app startup.
    func warm() async {
        guard !didWarm else { return }
        didWarm = true
        _ = try? await highlighter.request(
            "let _sergeCodeWarmup = 1",
            mode: .languageAlias("swift"),
            colors: .light(.xcode))
    }

    /// Maps Markdown fence tags to highlight.js language aliases. This is
    /// intentionally nonisolated so the mapping can be tested without a JS
    /// context or an actor hop.
    nonisolated static func mappedLanguage(for language: String?) -> String? {
        guard let language else { return nil }
        let normalized = language.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return nil }

        switch normalized {
        case "swift": return "swift"
        case "ts", "tsx", "typescript": return "typescript"
        case "js", "jsx", "javascript", "mjs", "cjs": return "javascript"
        case "json": return "json"
        case "py", "python": return "python"
        case "rb", "ruby": return "ruby"
        case "go", "golang": return "go"
        case "rs", "rust": return "rust"
        case "sh", "bash", "zsh", "shell": return "bash"
        case "c": return "c"
        case "cpp", "c++": return "cpp"
        case "cs", "csharp": return "csharp"
        case "java": return "java"
        case "kt", "kotlin": return "kotlin"
        case "php": return "php"
        case "html", "xml": return "xml"
        case "css": return "css"
        case "scss": return "scss"
        case "yaml", "yml": return "yaml"
        case "toml": return "toml"
        case "ini": return "ini"
        case "sql": return "sql"
        case "md", "markdown": return "markdown"
        case "diff": return "diff"
        case "dockerfile": return "dockerfile"
        case "objectivec", "objc": return "objectivec"
        case "plaintext": return nil
        default: return nil
        }
    }

    private func insert(_ value: AttributedString, for key: CacheKey) {
        cache[key] = value
        touch(key)

        guard mostRecentlyUsed.count > cacheCapacity,
            let evicted = mostRecentlyUsed.first
        else { return }
        mostRecentlyUsed.removeFirst()
        cache.removeValue(forKey: evicted)
    }

    private func touch(_ key: CacheKey) {
        mostRecentlyUsed.removeAll { $0 == key }
        mostRecentlyUsed.append(key)
    }

    /// HighlightSwift imports HTML attributes into the AppKit scope. SwiftUI
    /// Text reads the SwiftUI scope, so copy foreground colors across while
    /// discarding importer-owned background and font attributes.
    private func swiftUIAttributedText(from attributed: AttributedString) -> AttributedString {
        var result = AttributedString()
        for run in attributed.runs {
            var piece = AttributedString(attributed[run.range])
            if let color = run.appKit.foregroundColor {
                piece.foregroundColor = Color(nsColor: color)
            }
            piece.backgroundColor = nil
            piece.font = nil
            piece.appKit.foregroundColor = nil
            piece.appKit.backgroundColor = nil
            result.append(piece)
        }
        return result
    }
}
