import SwiftUI
import UIKit

/// Consecutive text blocks of a message (paragraphs, headings, and lists of
/// them) drawn as one attributed string by one `MarkdownTextCanvas`.
///
/// Each SwiftUI node in a transcript cell costs graph work every time the cell
/// is configured while scrolling, and that work dominated scroll hitches once
/// text views were gone. Merging a run turns 15-30 nodes into one. Code blocks,
/// tables, images, quotes, and rules stay separate views.
struct MarkdownTextRun: Equatable {
    enum Marker: Equatable {
        case bullet
        case number(Int)
        case task(MarkdownTaskState)
    }

    enum Piece: Equatable {
        case paragraph(MarkdownRenderedInline, depth: Int)
        case heading(level: Int, MarkdownRenderedInline)
        case listItem(Marker, MarkdownRenderedInline, depth: Int)
    }

    struct Line: Equatable {
        let piece: Piece
        /// Space above this line; the first line of a run has none.
        let spacingBefore: CGFloat
    }

    var lines: [Line]
}

extension MarkdownTextRun.Piece {
    /// Matches the line spacing each block used as its own text view.
    var lineSpacing: CGFloat {
        if case .heading = self { return 0 }
        return 4
    }
}

enum MarkdownBlockSegment {
    case text(MarkdownTextRun)
    case block(MarkdownRenderedBlock)
}

extension MarkdownTextRun {
    /// Long runs are split so one streamed chunk re-renders a bounded amount of text.
    static let maximumLines = 24

    /// Groups `blocks` into text runs and standalone blocks. `spacing` is the
    /// gap between blocks in this stack (matching `MarkdownBlocksView`).
    static func segments(_ blocks: [MarkdownRenderedBlock], spacing: CGFloat) -> [MarkdownBlockSegment] {
        var segments: [MarkdownBlockSegment] = []
        var run: [Line] = []
        func flush() {
            if !run.isEmpty { segments.append(.text(MarkdownTextRun(lines: run))) }
            run = []
        }
        for block in blocks {
            guard let pieces = textLines(for: block) else {
                flush()
                segments.append(.block(block))
                continue
            }
            if run.count + pieces.count > maximumLines { flush() }
            for (offset, line) in pieces.enumerated() {
                let gap = offset == 0 ? spacing + line.spacingBefore : line.spacingBefore
                run.append(Line(piece: line.piece, spacingBefore: run.isEmpty ? 0 : gap))
            }
        }
        flush()
        return segments
    }

    /// The block as text lines, or `nil` when it needs its own view. The first
    /// line's `spacingBefore` is added to the stack spacing.
    private static func textLines(for block: MarkdownRenderedBlock) -> [Line]? {
        switch block {
        case let .paragraph(inline):
            [Line(piece: .paragraph(inline, depth: 0), spacingBefore: 0)]
        case let .heading(level, inline):
            [Line(piece: .heading(level: level, inline), spacingBefore: level <= 2 ? 3 : 1)]
        case let .unorderedList(items):
            listLines(items, start: nil, depth: 0)
        case let .orderedList(start, items):
            listLines(items, start: start, depth: 0)
        default:
            nil
        }
    }

    private static func listLines(_ items: [MarkdownRenderedListItem], start: Int?, depth: Int) -> [Line]? {
        var lines: [Line] = []
        for (offset, item) in items.enumerated() {
            guard case let .paragraph(first)? = item.blocks.first else { return nil }
            let marker: Marker = item.task.map(Marker.task) ?? start.map { .number($0 + offset) } ?? .bullet
            lines.append(Line(piece: .listItem(marker, first, depth: depth), spacingBefore: offset == 0 ? 0 : 8))
            for block in item.blocks.dropFirst() {
                switch block {
                case let .paragraph(inline):
                    lines.append(Line(piece: .paragraph(inline, depth: depth + 1), spacingBefore: 7))
                case let .unorderedList(nested):
                    guard var nestedLines = listLines(nested, start: nil, depth: depth + 1) else { return nil }
                    nestedLines[0] = Line(piece: nestedLines[0].piece, spacingBefore: 7)
                    lines += nestedLines
                case let .orderedList(nestedStart, nested):
                    guard var nestedLines = listLines(nested, start: nestedStart, depth: depth + 1) else { return nil }
                    nestedLines[0] = Line(piece: nestedLines[0].piece, spacingBefore: 7)
                    lines += nestedLines
                default:
                    return nil
                }
            }
        }
        return lines.isEmpty ? nil : lines
    }
}

/// Builds and caches the attributed string for a run. Cells are reused for
/// different messages while scrolling, so the cache is shared, not per view.
@MainActor
enum MarkdownTextRunRenderer {
    private static let indent: CGFloat = 32
    private static let cache: NSCache<NSString, NSAttributedString> = {
        let cache = NSCache<NSString, NSAttributedString>()
        cache.countLimit = 1_024
        return cache
    }()

    static func attributedText(
        for run: MarkdownTextRun,
        textColor: UIColor,
        dynamicTypeSize: DynamicTypeSize,
        skills: [FeatureProviderSkill],
        traits: UITraitCollection
    ) -> NSAttributedString {
        let key = cacheKey(run, textColor: textColor, dynamicTypeSize: dynamicTypeSize, skills: skills, traits: traits)
        if let cached = cache.object(forKey: key) { return cached }
        let result = NSMutableAttributedString()
        var previousLineSpacing: CGFloat = 0
        for (index, line) in run.lines.enumerated() {
            if index > 0 { result.append(NSAttributedString(string: "\n")) }
            result.append(attributedLine(
                line, previousLineSpacing: previousLineSpacing,
                textColor: textColor, dynamicTypeSize: dynamicTypeSize, skills: skills, traits: traits
            ))
            previousLineSpacing = line.piece.lineSpacing
        }
        cache.setObject(result, forKey: key)
        return result
    }

    private static func attributedLine(
        _ line: MarkdownTextRun.Line,
        previousLineSpacing: CGFloat,
        textColor: UIColor,
        dynamicTypeSize: DynamicTypeSize,
        skills: [FeatureProviderSkill],
        traits: UITraitCollection
    ) -> NSAttributedString {
        let inline: MarkdownRenderedInline
        let lineSpacing = line.piece.lineSpacing
        var marker: NSAttributedString?
        var depth = 0
        switch line.piece {
        case let .paragraph(paragraph, paragraphDepth):
            inline = paragraph
            depth = paragraphDepth
        case let .heading(_, heading):
            inline = heading
        case let .listItem(itemMarker, item, itemDepth):
            inline = item
            depth = itemDepth
            marker = markerText(itemMarker, dynamicTypeSize: dynamicTypeSize)
        }
        let text = NSMutableAttributedString(attributedString: MarkdownSelectableTextAttributes.make(
            from: inline,
            lineSpacing: lineSpacing,
            foregroundColor: textColor,
            dynamicTypeSize: dynamicTypeSize,
            skills: skills,
            traits: traits
        ))
        let style = NSMutableParagraphStyle()
        style.lineSpacing = lineSpacing
        style.lineBreakMode = .byWordWrapping
        // String layout also puts the previous paragraph's line spacing after
        // its last line; separate text views did not, so take it back out.
        style.paragraphSpacingBefore = max(0, line.spacingBefore - previousLineSpacing)
        let leading = CGFloat(depth) * indent
        if let marker {
            // Marker right-aligned in a 24 pt column, text 8 pt after it, as in the
            // stacked list layout this replaces.
            style.firstLineHeadIndent = leading
            style.headIndent = leading + indent
            style.tabStops = [
                NSTextTab(textAlignment: .right, location: leading + 24),
                NSTextTab(textAlignment: .left, location: leading + indent),
            ]
            let prefix = NSMutableAttributedString(string: "\t")
            prefix.append(marker)
            prefix.append(NSAttributedString(string: "\t"))
            text.insert(prefix, at: 0)
        } else {
            style.firstLineHeadIndent = leading
            style.headIndent = leading
        }
        text.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: text.length))
        return text
    }

    private static func markerText(_ marker: MarkdownTextRun.Marker, dynamicTypeSize: DynamicTypeSize) -> NSAttributedString {
        let body = MarkdownInlineStyle.body.uiFont(dynamicTypeSize: dynamicTypeSize)
        switch marker {
        case .bullet:
            return NSAttributedString(string: "•", attributes: [
                .font: UIFont.systemFont(ofSize: body.pointSize, weight: .semibold),
                .foregroundColor: T3Colors.uiTextSecondary,
            ])
        case let .number(value):
            let size = UIFont.preferredFont(
                forTextStyle: .footnote,
                compatibleWith: UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicTypeSize))
            ).pointSize
            return NSAttributedString(string: "\(value).", attributes: [
                .font: UIFont.monospacedSystemFont(ofSize: size, weight: .regular),
                .foregroundColor: T3Colors.uiTextSecondary,
                .baselineOffset: (body.pointSize - size) / 4,
            ])
        case let .task(state):
            let complete = state == .complete
            let configuration = UIImage.SymbolConfiguration(pointSize: body.pointSize * 0.9, weight: .medium)
            let image = UIImage(systemName: complete ? "checkmark.square.fill" : "square", withConfiguration: configuration)?
                .withTintColor(complete ? UIColor(T3Colors.success) : T3Colors.uiTextSecondary, renderingMode: .alwaysOriginal)
            let attachment = NSTextAttachment()
            attachment.image = image
            if let image {
                attachment.bounds = CGRect(x: 0, y: body.descender, width: image.size.width, height: image.size.height)
            }
            return NSAttributedString(attachment: attachment)
        }
    }

    private static func cacheKey(
        _ run: MarkdownTextRun,
        textColor: UIColor,
        dynamicTypeSize: DynamicTypeSize,
        skills: [FeatureProviderSkill],
        traits: UITraitCollection
    ) -> NSString {
        var hasher = Hasher()
        for line in run.lines {
            switch line.piece {
            case let .paragraph(inline, depth):
                hasher.combine(0); hasher.combine(ObjectIdentifier(inline)); hasher.combine(depth)
            case let .heading(level, inline):
                hasher.combine(1); hasher.combine(ObjectIdentifier(inline)); hasher.combine(level)
            case let .listItem(marker, inline, depth):
                hasher.combine(2); hasher.combine(ObjectIdentifier(inline)); hasher.combine(depth)
                switch marker {
                case .bullet: hasher.combine(0)
                case let .number(value): hasher.combine(1); hasher.combine(value)
                case let .task(state): hasher.combine(2); hasher.combine(state == .complete)
                }
            }
            hasher.combine(line.spacingBefore)
        }
        hasher.combine(ObjectIdentifier(textColor))
        hasher.combine(dynamicTypeSize)
        hasher.combine(skills)
        hasher.combine(traits.userInterfaceStyle)
        return "\(hasher.finalize()):\(run.lines.count)" as NSString
    }
}

/// One text run, drawn by `MarkdownTextCanvas`.
struct MarkdownTextRunView: UIViewRepresentable, Equatable {
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @SwiftUI.Environment(\.openURL) private var openURL

    let run: MarkdownTextRun
    let textColor: UIColor
    let skills: [FeatureProviderSkill]
    let copyActionTitle: String
    let copyMessage: () -> Void

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.run == rhs.run && lhs.textColor == rhs.textColor && lhs.skills == rhs.skills
            && lhs.copyActionTitle == rhs.copyActionTitle
    }

    func makeUIView(context: Context) -> MarkdownTextCanvas {
        let canvas = MarkdownTextCanvas()
        canvas.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return canvas
    }

    func updateUIView(_ canvas: MarkdownTextCanvas, context: Context) {
        canvas.attributedText = MarkdownTextRunRenderer.attributedText(
            for: run,
            textColor: textColor,
            dynamicTypeSize: dynamicTypeSize,
            skills: skills,
            traits: canvas.traitCollection
        )
        canvas.onOpenURL = { openURL($0) }
        let copy = copyMessage
        canvas.accessibilityCustomActions = [
            UIAccessibilityCustomAction(name: copyActionTitle) { _ in
                copy()
                return true
            },
        ]
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: MarkdownTextCanvas, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
        // Fill the column like the stacked text views did; height follows the text.
        return CGSize(width: width, height: uiView.size(fitting: width).height)
    }
}
