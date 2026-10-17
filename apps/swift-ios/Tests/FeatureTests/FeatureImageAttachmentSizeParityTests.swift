import Testing
import UIKit
@testable import T3Code

@Suite("Image attachment size parity")
struct FeatureImageAttachmentSizeParityTests {
    @Test @MainActor func oversizedImagesFitTwoThousandPixelsOnEitherAxis() throws {
        for size in [CGSize(width: 2_048, height: 1_024), CGSize(width: 1_024, height: 2_048)] {
            let image = try processedImage(size: size)

            #expect(max(image.width, image.height) == 2_000)
            #expect(min(image.width, image.height) == 1_000)
        }
    }

    @Test @MainActor func smallImagesAreNotEnlarged() throws {
        let image = try processedImage(size: CGSize(width: 400, height: 200))

        #expect(image.width == 400)
        #expect(image.height == 200)
    }

    @MainActor private func processedImage(size: CGSize) throws -> CGImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let source = UIGraphicsImageRenderer(size: size, format: format).image { context in
            context.cgContext.setFillColor(UIColor.red.cgColor)
            context.cgContext.fill(CGRect(origin: .zero, size: size))
        }
        let sourceData = try #require(source.pngData())
        let attachment = try FeatureImageProcessor.attachment(from: sourceData, ordinal: 1)
        return try #require(UIImage(data: attachment.data)?.cgImage)
    }
}
