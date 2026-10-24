import ImageIO
import SwiftUI
import UIKit

enum MarkdownImageGeometry {
    static func sourceSize(_ dimensions: AssetImageDimensions?) -> CGSize? {
        guard let dimensions, dimensions.width > 0, dimensions.height > 0 else { return nil }
        return CGSize(width: dimensions.width, height: dimensions.height)
    }

    static func displaySize(sourceSize: CGSize?, availableWidth: CGFloat) -> CGSize {
        let width = availableWidth.isFinite ? max(0, availableWidth) : 320
        guard let sourceSize,
              sourceSize.width.isFinite, sourceSize.height.isFinite,
              sourceSize.width > 0, sourceSize.height > 0 else {
            return CGSize(width: width, height: 140)
        }
        let scale = min(width / sourceSize.width, 480 / sourceSize.height)
        return CGSize(width: sourceSize.width * scale, height: sourceSize.height * scale)
    }
}

/// Uses the parent's width on the first layout pass, including list and quote indents.
/// Metadata and the decoded image share this layout so downloading bytes does not resize the row.
struct MarkdownImageLayout: Layout {
    let sourceSize: CGSize?

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        MarkdownImageGeometry.displaySize(sourceSize: sourceSize, availableWidth: proposal.width ?? 320)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for subview in subviews {
            subview.place(at: bounds.origin, anchor: .topLeading, proposal: ProposedViewSize(bounds.size))
        }
    }
}

struct MarkdownDecodedImage: @unchecked Sendable {
    let image: UIImage
    let sourceSize: CGSize
}

enum MarkdownImageDecoder {
    static func decode(_ data: Data, maximumPixelSize: Int) throws -> MarkdownDecodedImage {
        guard let source = CGImageSourceCreateWithData(
            data as CFData,
            [kCGImageSourceShouldCache: false] as CFDictionary
        ), let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
           let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
           let height = properties[kCGImagePropertyPixelHeight] as? NSNumber else {
            throw MarkdownImageLoadingError.invalidImage
        }
        let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        let swapsAxes = (5...8).contains(orientation)
        let sourceSize = CGSize(
            width: swapsAxes ? height.doubleValue : width.doubleValue,
            height: swapsAxes ? width.doubleValue : height.doubleValue
        )
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, maximumPixelSize),
        ] as CFDictionary) else {
            throw MarkdownImageLoadingError.invalidImage
        }
        return MarkdownDecodedImage(image: UIImage(cgImage: thumbnail), sourceSize: sourceSize)
    }
}

enum MarkdownImageLoadingError: Error {
    case invalidImage
    case invalidResponse
}
