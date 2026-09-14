import ImageIO
import Testing
import UIKit
import UniformTypeIdentifiers
@testable import T3Code

@Suite("Markdown image rendering")
@MainActor
struct MarkdownImageRenderingTests {
    @Test
    func signedAssetDimensionsReserveTheSameFrameAfterDecode() throws {
        let result = try JSONDecoder.t3.decode(AssetCreateURLResult.self, from: Data(#"{"relativeUrl":"/api/assets/image.png","expiresAt":1785466800000,"imageDimensions":{"width":1600,"height":900}}"#.utf8))
        let data = try makeImage(width: 1_600, height: 900)
        let decoded = try MarkdownImageDecoder.decode(data, maximumPixelSize: 600)
        let waitingFrame = MarkdownImageGeometry.displaySize(
            sourceSize: MarkdownImageGeometry.sourceSize(result.imageDimensions),
            availableWidth: 360
        )
        let loadedFrame = MarkdownImageGeometry.displaySize(sourceSize: decoded.sourceSize, availableWidth: 360)

        #expect(waitingFrame == CGSize(width: 360, height: 202.5))
        #expect(loadedFrame == waitingFrame)
        #expect(decoded.image.size.width == 600)
        #expect((337...338).contains(decoded.image.size.height))
    }

    @Test
    func olderServersAndInvalidDimensionsKeepAUsablePlaceholder() throws {
        let result = try JSONDecoder.t3.decode(AssetCreateURLResult.self, from: Data(#"{"relativeUrl":"/api/assets/image.png","expiresAt":1785466800000}"#.utf8))
        #expect(result.imageDimensions == nil)
        #expect(MarkdownImageGeometry.sourceSize(AssetImageDimensions(width: 0, height: 300)) == nil)
        #expect(MarkdownImageGeometry.sourceSize(AssetImageDimensions(width: 300, height: -1)) == nil)
        #expect(MarkdownImageGeometry.displaySize(sourceSize: nil, availableWidth: 240) == CGSize(width: 240, height: 140))
    }

    @Test
    func portraitFramesStayBoundedAndNestedContentUsesItsOwnWidth() {
        let portrait = CGSize(width: 900, height: 1_600)
        #expect(MarkdownImageGeometry.displaySize(sourceSize: portrait, availableWidth: 360) == CGSize(width: 270, height: 480))
        #expect(MarkdownImageGeometry.displaySize(sourceSize: portrait, availableWidth: 180) == CGSize(width: 180, height: 320))
    }

    @Test
    func largeImagesDecodeAtDisplayResolution() throws {
        let data = try makeImage(width: 2_400, height: 1_600)
        let decoded = try MarkdownImageDecoder.decode(data, maximumPixelSize: 600)
        let cgImage = try #require(decoded.image.cgImage)
        #expect(decoded.sourceSize == CGSize(width: 2_400, height: 1_600))
        #expect(cgImage.width == 600)
        #expect(cgImage.height == 400)
        #expect(cgImage.bytesPerRow * cgImage.height < 1_100_000)
    }

    @Test
    func rotatedPhotosUseTheirDisplayedOrientation() throws {
        let data = try makeImage(width: 1_200, height: 800, orientation: 6)
        let decoded = try MarkdownImageDecoder.decode(data, maximumPixelSize: 600)
        #expect(decoded.sourceSize == CGSize(width: 800, height: 1_200))
        #expect(decoded.image.size == CGSize(width: 400, height: 600))
    }

    @Test
    func malformedImageFailsWithoutAllocatingAThumbnail() {
        #expect(throws: MarkdownImageLoadingError.self) {
            try MarkdownImageDecoder.decode(Data("not an image".utf8), maximumPixelSize: 600)
        }
    }

    private func makeImage(width: Int, height: Int, orientation: Int = 1) throws -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try #require(image.cgImage), [kCGImagePropertyOrientation: orientation] as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        return data as Data
    }
}
