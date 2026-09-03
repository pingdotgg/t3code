import SwiftUI
import UIKit

struct FeatureInlineSkillDescriptor: Equatable {
    let rawText: String
    let displayName: String
    let range: NSRange
}

extension FeatureProviderSkill {
    var invocationDisplayName: String {
        if let displayName = displayName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !displayName.isEmpty {
            return displayName
        }

        return name
            .split { $0.isWhitespace || $0 == ":" || $0 == "_" || $0 == "-" }
            .map { word in
                word.prefix(1).uppercased() + word.dropFirst()
            }
            .joined(separator: " ")
    }
}

enum FeatureInlineSkillParser {
    private static let tokenExpression = try! NSRegularExpression(
        pattern: #"(?<!\S)\$([A-Za-z][A-Za-z0-9:_-]*)(?=\s|$)"#
    )

    static func descriptors(
        in text: String,
        skills: [FeatureProviderSkill],
        allowsEndBoundary: Bool,
        preservingTrailing preserved: FeatureInlineSkillDescriptor? = nil
    ) -> [FeatureInlineSkillDescriptor] {
        guard !text.isEmpty, !skills.isEmpty else { return [] }

        let skillsByName = Dictionary(skills.map { ($0.name, $0) }) { first, _ in first }
        let source = text as NSString
        return tokenExpression.matches(
            in: text,
            range: NSRange(location: 0, length: source.length)
        ).compactMap { match in
            let range = match.range(at: 0)
            let hasEndBoundary = NSMaxRange(range) == source.length
            let preservesThisTrailingToken = hasEndBoundary
                && preserved?.range == range
                && preserved?.rawText == source.substring(with: range)
            guard !hasEndBoundary || allowsEndBoundary || preservesThisTrailingToken else {
                return nil
            }

            let name = source.substring(with: match.range(at: 1))
            guard let skill = skillsByName[name] else { return nil }
            return FeatureInlineSkillDescriptor(
                rawText: source.substring(with: range),
                displayName: skill.invocationDisplayName,
                range: range
            )
        }
    }
}

struct FeatureInlineSkillAttachmentSignature: Equatable {
    let descriptor: FeatureInlineSkillDescriptor
    let styleKey: String
}

extension NSAttributedString.Key {
    static let featureInlineSkillRawText = NSAttributedString.Key("t3.inline-skill.raw-text")
    static let featureInlineSkillDisplayName = NSAttributedString.Key("t3.inline-skill.display-name")
    static let featureInlineSkillStyleKey = NSAttributedString.Key("t3.inline-skill.style-key")
}

enum FeatureInlineSkillProjection {
    private struct Run {
        let displayRange: NSRange
        let plainRange: NSRange
        let rawText: String?
        let displayName: String?
        let styleKey: String?
    }

    static func plainText(from attributedText: NSAttributedString) -> String {
        let result = NSMutableString()
        let source = attributedText.string as NSString
        for run in runs(in: attributedText) {
            result.append(run.rawText ?? source.substring(with: run.displayRange))
        }
        return result as String
    }

    static func signatures(
        in attributedText: NSAttributedString
    ) -> [FeatureInlineSkillAttachmentSignature] {
        runs(in: attributedText).compactMap { run in
            guard let rawText = run.rawText,
                  let displayName = run.displayName,
                  let styleKey = run.styleKey else { return nil }
            return FeatureInlineSkillAttachmentSignature(
                descriptor: FeatureInlineSkillDescriptor(
                    rawText: rawText,
                    displayName: displayName,
                    range: run.plainRange
                ),
                styleKey: styleKey
            )
        }
    }

    static func plainRange(
        for displayRange: NSRange,
        in attributedText: NSAttributedString
    ) -> NSRange {
        guard displayRange.location != NSNotFound else { return NSRange(location: 0, length: 0) }
        let runs = runs(in: attributedText)
        let lower = plainOffset(for: displayRange.location, runs: runs, displayLength: attributedText.length)
        let upper = plainOffset(for: NSMaxRange(displayRange), runs: runs, displayLength: attributedText.length)
        return NSRange(location: lower, length: max(0, upper - lower))
    }

    static func displayRange(
        for plainRange: NSRange,
        in attributedText: NSAttributedString
    ) -> NSRange {
        guard plainRange.location != NSNotFound else { return NSRange(location: 0, length: 0) }
        let runs = runs(in: attributedText)
        let plainLength = runs.last.map { NSMaxRange($0.plainRange) } ?? 0
        let lower = displayOffset(for: plainRange.location, runs: runs, plainLength: plainLength)
        let upper = displayOffset(for: NSMaxRange(plainRange), runs: runs, plainLength: plainLength)
        return NSRange(location: lower, length: max(0, upper - lower))
    }

    private static func plainOffset(
        for displayOffset: Int,
        runs: [Run],
        displayLength: Int
    ) -> Int {
        let target = min(max(displayOffset, 0), displayLength)
        var lengthDelta = 0
        for run in runs where run.rawText != nil {
            guard target > run.displayRange.location else { break }
            if target <= NSMaxRange(run.displayRange) {
                return NSMaxRange(run.plainRange)
            }
            lengthDelta += run.plainRange.length - run.displayRange.length
        }
        return target + lengthDelta
    }

    private static func displayOffset(
        for plainOffset: Int,
        runs: [Run],
        plainLength: Int
    ) -> Int {
        let target = min(max(plainOffset, 0), plainLength)
        var lengthDelta = 0
        for run in runs where run.rawText != nil {
            guard target > run.plainRange.location else { break }
            if target <= NSMaxRange(run.plainRange) {
                return NSMaxRange(run.displayRange)
            }
            lengthDelta += run.plainRange.length - run.displayRange.length
        }
        return target - lengthDelta
    }

    private static func runs(in attributedText: NSAttributedString) -> [Run] {
        var result: [Run] = []
        var plainOffset = 0
        let source = attributedText.string as NSString
        attributedText.enumerateAttributes(
            in: NSRange(location: 0, length: attributedText.length)
        ) { attributes, displayRange, _ in
            let isSkillAttachment = displayRange.length == 1
                && source.character(at: displayRange.location) == 0xFFFC
                && attributes[.attachment] is NSTextAttachment
            let rawText = isSkillAttachment
                ? attributes[.featureInlineSkillRawText] as? String
                : nil
            let plainLength = rawText.map { ($0 as NSString).length } ?? displayRange.length
            result.append(
                Run(
                    displayRange: displayRange,
                    plainRange: NSRange(location: plainOffset, length: plainLength),
                    rawText: rawText,
                    displayName: rawText == nil
                        ? nil
                        : attributes[.featureInlineSkillDisplayName] as? String,
                    styleKey: rawText == nil
                        ? nil
                        : attributes[.featureInlineSkillStyleKey] as? String
                )
            )
            plainOffset += plainLength
        }
        return result
    }
}

@MainActor
enum FeatureInlineSkillPillRenderer {
    private static let imageCache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 128
        return cache
    }()

    static func attributedText(
        source: String,
        descriptors: [FeatureInlineSkillDescriptor],
        baseAttributes: [NSAttributedString.Key: Any],
        font: UIFont,
        traits: UITraitCollection
    ) -> NSAttributedString {
        guard !descriptors.isEmpty else {
            return NSAttributedString(string: source, attributes: baseAttributes)
        }
        let result = NSMutableAttributedString()
        let sourceText = source as NSString
        let styleKey = styleKey(font: font, traits: traits)
        var cursor = 0

        for descriptor in descriptors where descriptor.range.location >= cursor {
            if descriptor.range.location > cursor {
                result.append(
                    NSAttributedString(
                        string: sourceText.substring(
                            with: NSRange(location: cursor, length: descriptor.range.location - cursor)
                        ),
                        attributes: baseAttributes
                    )
                )
            }

            let attachment = NSTextAttachment()
            let renderedPill = image(
                label: descriptor.displayName,
                font: font,
                traits: traits
            )
            attachment.image = renderedPill
            attachment.bounds = CGRect(
                x: 0,
                y: (font.capHeight - renderedPill.size.height) / 2,
                width: renderedPill.size.width,
                height: renderedPill.size.height
            )
            let attachmentText = NSMutableAttributedString(attachment: attachment)
            attachmentText.addAttributes(
                baseAttributes.merging(
                    [
                        .featureInlineSkillRawText: descriptor.rawText,
                        .featureInlineSkillDisplayName: descriptor.displayName,
                        .featureInlineSkillStyleKey: styleKey,
                    ],
                    uniquingKeysWith: { _, replacement in replacement }
                ),
                range: NSRange(location: 0, length: attachmentText.length)
            )
            result.append(attachmentText)
            cursor = NSMaxRange(descriptor.range)
        }

        if cursor < sourceText.length {
            result.append(
                NSAttributedString(
                    string: sourceText.substring(from: cursor),
                    attributes: baseAttributes
                )
            )
        }
        return result
    }

    static func signatures(
        for descriptors: [FeatureInlineSkillDescriptor],
        font: UIFont,
        traits: UITraitCollection
    ) -> [FeatureInlineSkillAttachmentSignature] {
        let styleKey = styleKey(font: font, traits: traits)
        return descriptors.map {
            FeatureInlineSkillAttachmentSignature(descriptor: $0, styleKey: styleKey)
        }
    }

    private static func styleKey(font: UIFont, traits: UITraitCollection) -> String {
        [
            String(format: "%.3f", font.pointSize),
            String(traits.userInterfaceStyle.rawValue),
            traits.preferredContentSizeCategory.rawValue,
            String(format: "%.2f", traits.displayScale),
        ].joined(separator: ":")
    }

    private static func image(
        label: String,
        font: UIFont,
        traits: UITraitCollection
    ) -> UIImage {
        let cacheKey = "\(styleKey(font: font, traits: traits))\u{0}\(label)" as NSString
        if let cached = imageCache.object(forKey: cacheKey) {
            return cached
        }
        let labelFont = UIFont.systemFont(ofSize: max(11, font.pointSize * 0.86), weight: .medium)
        let pillHeight = max(18, font.pointSize * 1.41)
        let iconSize = max(12, labelFont.pointSize * 1.08)
        let horizontalPadding = max(6, font.pointSize * 0.5)
        let gap = max(4, font.pointSize * 0.28)
        let maximumLabelWidth: CGFloat = 190
        let measuredLabelWidth = (label as NSString).size(withAttributes: [.font: labelFont]).width
        let labelWidth = min(maximumLabelWidth, ceil(measuredLabelWidth))
        let size = CGSize(
            width: ceil(horizontalPadding * 2 + iconSize + gap + labelWidth),
            height: ceil(pillHeight)
        )

        let format = UIGraphicsImageRendererFormat()
        format.scale = traits.displayScale > 0 ? traits.displayScale : UIScreen.main.scale
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let rendered = renderer.image { _ in
            let foreground = UIColor { currentTraits in
                currentTraits.userInterfaceStyle == .dark
                    ? UIColor(red: 240 / 255, green: 171 / 255, blue: 252 / 255, alpha: 1)
                    : UIColor(red: 162 / 255, green: 28 / 255, blue: 175 / 255, alpha: 1)
            }.resolvedColor(with: traits)
            let fuchsia = UIColor(red: 217 / 255, green: 70 / 255, blue: 239 / 255, alpha: 1)
            let bounds = CGRect(origin: .zero, size: size).insetBy(dx: 0.5, dy: 0.5)
            let path = UIBezierPath(
                roundedRect: bounds,
                cornerRadius: labelFont.pointSize * 0.5
            )
            fuchsia.withAlphaComponent(0.12).setFill()
            path.fill()
            fuchsia.withAlphaComponent(0.25).setStroke()
            path.lineWidth = 1
            path.stroke()

            let iconOrigin = CGPoint(
                x: horizontalPadding,
                y: (size.height - iconSize) / 2
            )
            if let icon = UIImage(
                systemName: "shippingbox",
                withConfiguration: UIImage.SymbolConfiguration(
                    pointSize: iconSize,
                    weight: .regular
                )
            )?.withTintColor(foreground, renderingMode: .alwaysOriginal) {
                icon.draw(in: CGRect(origin: iconOrigin, size: CGSize(width: iconSize, height: iconSize)))
            }

            let paragraphStyle = NSMutableParagraphStyle()
            paragraphStyle.lineBreakMode = .byTruncatingTail
            let labelRect = CGRect(
                x: horizontalPadding + iconSize + gap,
                y: (size.height - labelFont.lineHeight) / 2,
                width: labelWidth,
                height: labelFont.lineHeight
            )
            (label as NSString).draw(
                with: labelRect,
                options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
                attributes: [
                    .font: labelFont,
                    .foregroundColor: foreground,
                    .paragraphStyle: paragraphStyle,
                ],
                context: nil
            )
        }
        imageCache.setObject(rendered, forKey: cacheKey)
        return rendered
    }
}

/// Makes selected pill text portable. UIKit otherwise copies an attachment as
/// rich image data or the object-replacement character instead of `$skill`.
class FeatureInlineSkillTextView: UITextView {
    override func copy(_ sender: Any?) {
        guard let selectedPlainText else {
            super.copy(sender)
            return
        }
        UIPasteboard.general.string = selectedPlainText
    }

    override func cut(_ sender: Any?) {
        guard let selectedPlainText else {
            super.cut(sender)
            return
        }
        super.cut(sender)
        UIPasteboard.general.string = selectedPlainText
    }

    private var selectedPlainText: String? {
        let range = selectedRange
        guard range.location != NSNotFound,
              range.length > 0,
              NSMaxRange(range) <= attributedText.length else {
            return nil
        }
        let selected = attributedText.attributedSubstring(from: range)
        guard !FeatureInlineSkillProjection.signatures(in: selected).isEmpty else { return nil }
        return FeatureInlineSkillProjection.plainText(from: selected)
    }
}
