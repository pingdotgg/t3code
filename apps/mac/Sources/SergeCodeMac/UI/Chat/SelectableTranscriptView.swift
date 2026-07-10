import AppKit
import SwiftUI
import T3Kit

// Conversation-wide text selection. SwiftUI scopes `.textSelection` per Text
// view, so sibling timeline rows can never share one selection range. This
// sheet flattens the same display items the timeline renders into a single
// non-editable NSTextView where drag, ⌘A, and ⌘C work across everything.

// MARK: - Environment

/// MainActor UI action; optional so rows without a chat host hide the menu item.
typealias OpenSelectTextAction = @MainActor @Sendable () -> Void

private enum OpenSelectTextKey: EnvironmentKey {
    static let defaultValue: OpenSelectTextAction? = nil
}

extension EnvironmentValues {
    /// Opens the Select Text sheet for the current chat transcript.
    var openSelectText: OpenSelectTextAction? {
        get { self[OpenSelectTextKey.self] }
        set { self[OpenSelectTextKey.self] = newValue }
    }
}

// MARK: - Sheet

struct SelectableTranscriptSheet: View {
    let items: [TimelineDisplayItem]
    /// Optional project root for path shortening in tool rows.
    var projectRoot: String? = nil

    @Environment(\.dismiss) private var dismiss

    private var attributed: NSAttributedString {
        TranscriptTextBuilder.attributedString(from: items, projectRoot: projectRoot)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Select Text")
                    .font(.headline)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            Divider()

            SelectableTranscriptTextView(attributed: attributed)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 560, minHeight: 420)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

// MARK: - NSTextView host

struct SelectableTranscriptTextView: NSViewRepresentable {
    let attributed: NSAttributedString

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        guard let textView = scrollView.documentView as? NSTextView else { return scrollView }

        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.allowsUndo = false
        textView.drawsBackground = true
        textView.backgroundColor = .textBackgroundColor
        textView.textContainerInset = NSSize(width: 16, height: 16)
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.containerSize = NSSize(
            width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.font = .systemFont(ofSize: NSFont.systemFontSize)
        textView.textStorage?.setAttributedString(attributed)

        DispatchQueue.main.async {
            textView.scrollToEndOfDocument(nil)
        }
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        // Sheet content is fixed at open; only re-apply if the representable
        // is reused with different items.
        if textView.string != attributed.string {
            textView.textStorage?.setAttributedString(attributed)
            DispatchQueue.main.async {
                textView.scrollToEndOfDocument(nil)
            }
        }
    }
}

// MARK: - Flattening

/// Pure builder: timeline display items → one selectable attributed string.
@MainActor
enum TranscriptTextBuilder {
    private static var bodyFont: NSFont {
        NSFont.systemFont(ofSize: NSFont.systemFontSize)
    }
    private static var monoFont: NSFont {
        NSFont.monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
    }
    private static var captionMono: NSFont {
        NSFont.monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
    }
    private static var headerFont: NSFont {
        NSFont.systemFont(ofSize: NSFont.systemFontSize, weight: .semibold)
    }

    static func attributedString(
        from items: [TimelineDisplayItem],
        projectRoot: String? = nil
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()
        var didWrite = false

        for display in items {
            switch display {
            case .single(let item):
                if append(item, to: result, projectRoot: projectRoot, leadingBreak: didWrite) {
                    didWrite = true
                }
            case .toolGroup(_, let groupItems, let summary):
                if didWrite { appendBlankLine(to: result) }
                appendHeader("Tools", to: result)
                appendPlain(
                    summaryLine(summary),
                    font: bodyFont,
                    color: .secondaryLabelColor,
                    to: result)
                for nested in groupItems {
                    _ = append(nested, to: result, projectRoot: projectRoot, leadingBreak: true)
                }
                didWrite = true
            }
        }
        return result
    }

    /// Returns true when something was appended.
    @discardableResult
    private static func append(
        _ item: TimelineItem,
        to result: NSMutableAttributedString,
        projectRoot: String?,
        leadingBreak: Bool
    ) -> Bool {
        switch item {
        case .userMessage(_, let text, _):
            if leadingBreak { appendBlankLine(to: result) }
            appendHeader("You", to: result)
            appendPlain(text, font: bodyFont, color: .labelColor, to: result)
            return true

        case .assistantMessage(_, let markdown, _, _):
            if leadingBreak { appendBlankLine(to: result) }
            appendHeader("Assistant", to: result)
            appendSwiftUI(attributedMarkdownDocument(markdown), to: result)
            return true

        case .toolEvent(_, let name, let detail, let kind, let status, _, let output, let outputIsError):
            if leadingBreak { appendBlankLine(to: result) }
            let statusLabel = toolStatusLabel(status)
            appendHeader("Tool · \(name)\(statusLabel)", to: result)
            appendToolBody(
                detail: detail, kind: kind, output: output, outputIsError: outputIsError,
                projectRoot: projectRoot, to: result)
            return true

        case .subagentTask(let task):
            if leadingBreak { appendBlankLine(to: result) }
            let title =
                task.description?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                ? task.description! : "Subagent task"
            appendHeader("Subagent · \(title)", to: result)
            if let progress = task.latestProgress?.trimmingCharacters(in: .whitespacesAndNewlines),
                !progress.isEmpty
            {
                appendPlain(progress, font: bodyFont, color: .secondaryLabelColor, to: result)
            }
            if !task.progressLog.isEmpty {
                let log = SubagentProgressLogText.attributedBody(
                    entries: task.progressLog,
                    startedAt: task.startedAt,
                    emphasizeLast: task.state == .running)
                if result.length > 0 { result.append(NSAttributedString(string: "\n")) }
                appendSwiftUI(log, to: result)
            }
            if let error = task.error?.trimmingCharacters(in: .whitespacesAndNewlines),
                !error.isEmpty
            {
                if result.length > 0 { result.append(NSAttributedString(string: "\n")) }
                appendPlain(error, font: bodyFont, color: .systemRed, to: result)
            }
            return true

        case .reasoning(_, let text, _):
            if leadingBreak { appendBlankLine(to: result) }
            appendHeader("Reasoning", to: result)
            appendPlain(text, font: bodyFont, color: .secondaryLabelColor, to: result)
            return true

        case .notice(_, let text, _):
            if leadingBreak { appendBlankLine(to: result) }
            appendHeader("Notice", to: result)
            appendPlain(text, font: bodyFont, color: .secondaryLabelColor, to: result)
            return true

        case .checkpoint(let checkpoint):
            if leadingBreak { appendBlankLine(to: result) }
            appendHeader("Checkpoint", to: result)
            appendPlain(checkpoint.label, font: bodyFont, color: .secondaryLabelColor, to: result)
            return true

        case .approval(let request):
            // Text only — skip interactive chrome.
            if leadingBreak { appendBlankLine(to: result) }
            appendHeader("Approval", to: result)
            appendPlain(request.title, font: bodyFont, color: .labelColor, to: result)
            if !request.detail.isEmpty {
                result.append(NSAttributedString(string: "\n"))
                appendPlain(request.detail, font: bodyFont, color: .secondaryLabelColor, to: result)
            }
            return true

        case .plan(let plan):
            if leadingBreak { appendBlankLine(to: result) }
            appendHeader("Plan", to: result)
            appendSwiftUI(attributedMarkdownDocument(plan.markdown), to: result)
            return true

        case .userInput(let request):
            if leadingBreak { appendBlankLine(to: result) }
            appendHeader("Input requested", to: result)
            for (index, question) in request.questions.enumerated() {
                if index > 0 { result.append(NSAttributedString(string: "\n")) }
                let header =
                    question.header.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? question.question : "\(question.header): \(question.question)"
                appendPlain(header, font: bodyFont, color: .labelColor, to: result)
            }
            return true

        case .usageLimit(let notice):
            if leadingBreak { appendBlankLine(to: result) }
            appendHeader("Usage limit", to: result)
            appendPlain(notice.message, font: bodyFont, color: .secondaryLabelColor, to: result)
            return true
        }
    }

    private static func appendToolBody(
        detail: String,
        kind: ToolEventKind,
        output: String?,
        outputIsError: Bool,
        projectRoot: String?,
        to result: NSMutableAttributedString
    ) {
        let parsed = ParsedToolDetail.parse(detail: detail, itemType: kind.wireItemType)
        switch parsed {
        case .command(let command):
            appendMono(command, color: .labelColor, to: result)
        case .fileChange(let path, let edits):
            let short = PathDisplay.short(path, projectRoot: projectRoot)
            appendMono(short, color: .secondaryLabelColor, to: result)
            let lines = FileChangeDiffText.attributedBody(diffLines(from: edits))
            result.append(NSAttributedString(string: "\n"))
            appendSwiftUI(lines, to: result)
        case .plain(let text):
            if !text.isEmpty {
                appendMono(text, color: .secondaryLabelColor, to: result)
            }
        }
        if let output, !output.isEmpty {
            result.append(NSAttributedString(string: "\n"))
            appendPlain("Output", font: captionMono, color: .secondaryLabelColor, to: result)
            result.append(NSAttributedString(string: "\n"))
            appendMono(
                output,
                color: outputIsError ? .systemRed : .secondaryLabelColor,
                to: result)
        }
    }

    private static func diffLines(from edits: [ToolFileEdit]) -> [(
        kind: FileChangeDiffText.Kind, text: String
    )] {
        var lines: [(kind: FileChangeDiffText.Kind, text: String)] = []
        for (index, edit) in edits.enumerated() {
            if index > 0 { lines.append((.separator, "···")) }
            if !edit.oldText.isEmpty {
                for line in edit.oldText.split(separator: "\n", omittingEmptySubsequences: false) {
                    lines.append((.removed, String(line)))
                }
            }
            if !edit.newText.isEmpty {
                for line in edit.newText.split(separator: "\n", omittingEmptySubsequences: false) {
                    lines.append((.added, String(line)))
                }
            }
        }
        return lines
    }

    private static func summaryLine(_ summary: ToolGroupSummary) -> String {
        var parts = ["Ran \(summary.toolCount) tool\(summary.toolCount == 1 ? "" : "s")"]
        if summary.editedFileCount > 0 {
            parts.append(
                "edited \(summary.editedFileCount) file\(summary.editedFileCount == 1 ? "" : "s")")
        }
        if summary.failedCount > 0 {
            parts.append("\(summary.failedCount) failed")
        }
        return parts.joined(separator: " · ")
    }

    private static func toolStatusLabel(_ status: ToolEventStatus) -> String {
        switch status {
        case .running: " · running"
        case .succeeded: ""
        case .failed: " · failed"
        }
    }

    private static func appendHeader(_ title: String, to result: NSMutableAttributedString) {
        let attrs: [NSAttributedString.Key: Any] = [
            .font: headerFont,
            .foregroundColor: NSColor.secondaryLabelColor,
        ]
        result.append(NSAttributedString(string: title + "\n", attributes: attrs))
    }

    private static func appendPlain(
        _ text: String,
        font: NSFont,
        color: NSColor,
        to result: NSMutableAttributedString
    ) {
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: color,
        ]
        result.append(NSAttributedString(string: text, attributes: attrs))
    }

    private static func appendMono(
        _ text: String,
        color: NSColor,
        to result: NSMutableAttributedString
    ) {
        let attrs: [NSAttributedString.Key: Any] = [
            .font: monoFont,
            .foregroundColor: color,
            .backgroundColor: NSColor.textBackgroundColor,
        ]
        result.append(NSAttributedString(string: text, attributes: attrs))
    }

    private static func appendBlankLine(to result: NSMutableAttributedString) {
        result.append(NSAttributedString(string: "\n\n"))
    }

    private static func appendSwiftUI(
        _ attributed: AttributedString,
        to result: NSMutableAttributedString
    ) {
        result.append(NSAttributedString(attributed))
    }
}

extension ToolEventKind {
    /// Wire item type for ParsedToolDetail — same mapping ToolEventRow uses.
    fileprivate var wireItemType: String? {
        switch self {
        case .command: "command_execution"
        case .fileChange: "file_change"
        case .fileRead: "file_read"
        case .webSearch: "web_search"
        case .mcpCall: "mcp_tool_call"
        case .subagent: "collab_agent_tool_call"
        case .imageView: "image_view"
        case .other: nil
        }
    }
}
