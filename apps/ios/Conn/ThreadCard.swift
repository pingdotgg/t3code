import SwiftUI
import UniformTypeIdentifiers

struct ThreadCard<Header: View, Content: View>: View {
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var appearance
    @ViewBuilder let header: Header
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) { header }
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(theme.mutedForeground)
                .padding(.leading, 11)
                .padding(.trailing, 5)
                .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
            content
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(appearance == .light ? Color.white : theme.card.mix(with: .white, by: 0.06))
                .clipShape(.rect(cornerRadius: 11))
        }
        .padding(3)
        .background(theme.card, in: .rect(cornerRadius: 14))
    }
}

struct CopyTextButton: View {
    let label: String
    let text: String
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = text
            copied = true
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .frame(width: 28, height: 28)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(copied ? "Copied" : label)
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .milliseconds(1200))
            if !Task.isCancelled { copied = false }
        }
    }
}

struct MarkdownDocument: FileDocument {
    static let readableContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
    let text: String
    init(text: String) { self.text = text }
    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else { throw CocoaError(.fileReadCorruptFile) }
        text = String(decoding: data, as: UTF8.self)
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}

struct CodeCard: View {
    let code: String
    let language: String?
    var title: String? = nil
    @Environment(\.connTheme) private var theme
    @State private var wrap = false

    private var label: String {
        guard let lang = language?.lowercased(), !lang.isEmpty else { return "Text" }
        return ["sh":"Shell", "bash":"Shell", "rs":"Rust", "js":"JavaScript", "ts":"TypeScript",
                "jsx":"JSX", "tsx":"TSX", "json":"JSON", "css":"CSS", "html":"HTML", "md":"Markdown",
                "py":"Python", "yml":"YAML", "yaml":"YAML", "sql":"SQL", "txt":"Text"][lang] ?? lang.capitalized
    }

    var body: some View {
        ThreadCard {
            ConnIcon("doc.text").font(.system(size: 14))
            Text(title ?? label)
            Spacer()
            Button {
                wrap.toggle()
            } label: {
                Image(systemName: "return").frame(width: 28, height: 28)
            }
            .accessibilityLabel("Toggle word wrap")
            .accessibilityValue(wrap ? "On" : "Off")
            CopyTextButton(label: "Copy code", text: code)
        } content: {
            if wrap {
                source
            } else {
                ScrollView(.horizontal) { source.fixedSize(horizontal: true, vertical: false) }
            }
        }
        .buttonStyle(.plain)
    }

    private var source: some View {
        HighlightedSource(code: code, language: language ?? "")
            .padding(.horizontal, 11).padding(.vertical, 9)
    }
}

struct HighlightedSource: View {
    let code: String
    let language: String
    @Environment(\.connTheme) private var theme
    @State private var formatted: AttributedString?

    private struct Input: Equatable { let code, language, theme: String }

    var body: some View {
        let input = Input(code: code, language: language, theme: theme.themeId)
        Text(formatted ?? AttributedString(code))
            .font(.system(size: 13, design: .monospaced))
            .foregroundStyle(theme.codeForeground)
            .textSelection(.enabled)
            .task(id: input) {
                formatted = nil
                guard !language.isEmpty, code.utf8.count <= 512 * 1024 else { return }
                let highlighted = await Task.detached(priority: .utility) {
                    let lines = highlightCode(source: input.code, language: input.language, theme: input.theme)
                    var result = AttributedString()
                    for (i, line) in lines.enumerated() {
                        if i > 0 { result += AttributedString("\n") }
                        result += attributedCodeLine(line)
                    }
                    return result
                }.value
                if !Task.isCancelled && !highlighted.characters.isEmpty { formatted = highlighted }
            }
    }
}

func attributedCodeLine(_ spans: [FfiCodeSpan]) -> AttributedString {
    var line = AttributedString()
    for span in spans {
        var token = AttributedString(span.text)
        token.foregroundColor = Color(ffi: span.color)
        var intent: InlinePresentationIntent = []
        if span.bold { intent.insert(.stronglyEmphasized) }
        if span.italic { intent.insert(.emphasized) }
        if !intent.isEmpty { token.inlinePresentationIntent = intent }
        line += token
    }
    return line
}

struct ComposerDeck: ViewModifier {
    let remaining: Int
    @Environment(\.colorScheme) private var appearance
    @Environment(\.connTheme) private var theme

    func body(content: Content) -> some View {
        let layers = min(max(remaining - 1, 0), 2)
        content
            .padding(.top, CGFloat(layers * 6))
            .background {
                ForEach((1..<(layers + 1)).reversed(), id: \.self) { depth in
                    RoundedRectangle(cornerRadius: 28)
                        .fill(theme.card)
                        .overlay { RoundedRectangle(cornerRadius: 28).strokeBorder(theme.border.opacity(0.5)) }
                        .shadow(color: .black.opacity(appearance == .light ? 0.07 : 0.16), radius: 16, y: 1)
                        .padding(.horizontal, CGFloat(depth * 8))
                        .padding(.top, CGFloat((layers - depth) * 6))
                        .padding(.bottom, CGFloat(depth * 6))
                }
            }
    }
}

func threadDate(_ text: String?) -> Date? {
    guard let text else { return nil }
    return (try? Date(text, strategy: .iso8601.time(includingFractionalSeconds: true)))
        ?? (try? Date(text, strategy: .iso8601))
}

func threadElapsed(_ start: String?, _ end: String?) -> String? {
    guard let a = threadDate(start), let b = threadDate(end), b >= a else { return nil }
    let seconds = Int(b.timeIntervalSince(a))
    return seconds >= 60 ? "\(seconds / 60)m \(seconds % 60)s" : "\(seconds)s"
}
