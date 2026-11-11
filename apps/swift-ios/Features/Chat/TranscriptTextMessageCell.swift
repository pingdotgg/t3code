import SwiftUI
import UIKit

/// A completed assistant reply made only of text, as a plain UIKit cell.
///
/// Every SwiftUI-hosted cell rebuilds and measures a view graph when it is
/// recycled for another message, and that was most of the remaining scroll
/// cost. Text-only replies are the most common row, so they skip SwiftUI:
/// their height is the sum of their text runs, computed directly. Replies with
/// code, tables, media, attachments, or context links, and the one message in
/// "Select Text" mode, keep the SwiftUI cell.
final class TranscriptTextMessageCell: UICollectionViewCell {
    struct Content {
        let runs: [MarkdownTextRun]
        let skills: [FeatureProviderSkill]
        let dynamicTypeSize: DynamicTypeSize
        let timestamp: String?
        let fork: Fork?
        let messageID: String
        let onOpenURL: (URL) -> Void
        let onCopy: () -> Void

        struct Fork {
            let itemID: String
            let isBusy: Bool
            let action: () -> Void
        }
    }

    /// Matches `MarkdownBlocksView`'s spacing between consecutive runs.
    private static let runSpacing: CGFloat = 12

    private var content: Content?
    private var canvases: [MarkdownTextCanvas] = []
    private let timestampLabel = UILabel()
    private let forkButton = UIButton(type: .system)
    private var heights: (width: CGFloat, height: CGFloat)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        timestampLabel.textColor = UIColor(T3Colors.textTertiary)
        timestampLabel.adjustsFontForContentSizeCategory = false
        contentView.addSubview(timestampLabel)
        var configuration = UIButton.Configuration.plain()
        configuration.image = UIImage(systemName: "arrow.triangle.branch")
        configuration.baseForegroundColor = T3Colors.uiTextPrimary
        configuration.contentInsets = .zero
        forkButton.configuration = configuration
        forkButton.addAction(UIAction { [weak self] _ in self?.content?.fork?.action() }, for: .primaryActionTriggered)
        contentView.addSubview(forkButton)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (cell: Self, _) in
            if let content = cell.content { cell.configure(content) }
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func configure(_ content: Content) {
        self.content = content
        heights = nil
        while canvases.count < content.runs.count {
            let canvas = MarkdownTextCanvas()
            contentView.addSubview(canvas)
            canvases.append(canvas)
        }
        while canvases.count > content.runs.count {
            canvases.removeLast().removeFromSuperview()
        }
        for (canvas, run) in zip(canvases, content.runs) {
            canvas.attributedText = MarkdownTextRunRenderer.attributedText(
                for: run,
                textColor: T3Colors.uiTextPrimary,
                dynamicTypeSize: content.dynamicTypeSize,
                skills: content.skills,
                traits: traitCollection
            )
            canvas.onOpenURL = content.onOpenURL
            canvas.accessibilityCustomActions = [
                UIAccessibilityCustomAction(name: "Copy message") { _ in
                    content.onCopy()
                    return true
                },
            ]
        }
        timestampLabel.font = UIFont.preferredFont(
            forTextStyle: .footnote,
            compatibleWith: UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(content.dynamicTypeSize))
        )
        timestampLabel.text = content.timestamp
        timestampLabel.isHidden = content.timestamp == nil
        forkButton.isHidden = content.fork == nil
        forkButton.isEnabled = content.fork?.isBusy != true
        forkButton.accessibilityLabel = content.fork?.isBusy == true ? "Creating fork" : "Fork from this response"
        forkButton.accessibilityIdentifier = content.fork.map { "thread-fork-\($0.itemID)" }
        contentView.accessibilityIdentifier = "message-\(content.messageID)"
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        _ = layout(width: contentView.bounds.width, apply: true)
    }

    override func preferredLayoutAttributesFitting(
        _ attributes: UICollectionViewLayoutAttributes
    ) -> UICollectionViewLayoutAttributes {
        let fitted = attributes.copy() as! UICollectionViewLayoutAttributes
        let width = attributes.size.width
        if let heights, heights.width == width {
            fitted.size.height = heights.height
        } else {
            let height = layout(width: width, apply: false)
            heights = (width, height)
            fitted.size.height = height
        }
        return fitted
    }

    /// One pass for both measuring and placing, so they can never disagree.
    private func layout(width: CGFloat, apply: Bool) -> CGFloat {
        var y: CGFloat = 0
        for (index, canvas) in canvases.enumerated() {
            if index > 0 { y += Self.runSpacing }
            let size = canvas.size(fitting: width)
            if apply { canvas.frame = CGRect(x: 0, y: y, width: width, height: size.height) }
            y += size.height
        }
        if !timestampLabel.isHidden {
            let height = ceil(timestampLabel.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
            if apply { timestampLabel.frame = CGRect(x: 0, y: y, width: width, height: height) }
            y += height
        }
        if !forkButton.isHidden {
            if apply {
                forkButton.frame = CGRect(x: 0, y: y, width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
            }
            y += T3Metrics.minimumTapTarget
        }
        return max(1, ceil(y))
    }
}
