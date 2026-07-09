import AppKit
import CoreGraphics
import Foundation

/// Builds a compact, dark-UI-safe palette from a deterministic sample of a
/// scenery set's downloaded images. Work is synchronous by design; callers
/// run URL-backed extraction in a detached utility task.
enum SceneryPaletteExtractor {
    static let maximumImageCount = 8
    static let gradientPairCount = 6

    private static let bitmapSide = 32
    private static let hueBucketCount = 24

    private struct Pixel {
        var red: Double
        var green: Double
        var blue: Double
    }

    private struct HueBucket {
        var index: Int
        var count = 0
        var score = 0.0
        var hueX = 0.0
        var hueY = 0.0
        var saturationTotal = 0.0
        var brightnessTotal = 0.0

        var hue: Double {
            guard abs(hueX) > .ulpOfOne || abs(hueY) > .ulpOfOne else { return 0 }
            let angle = atan2(hueY, hueX) / (2 * .pi)
            return angle >= 0 ? angle : angle + 1
        }

        var saturation: Double {
            count > 0 ? saturationTotal / Double(count) : 0
        }

        var brightness: Double {
            count > 0 ? brightnessTotal / Double(count) : 0
        }
    }

    /// Test-friendly entry point for already-decoded images.
    static func extract(from images: [NSImage]) -> SceneryPalette? {
        let pixels = images.prefix(maximumImageCount).flatMap(samplePixels)
        return makePalette(from: pixels)
    }

    /// Production entry point. Images are decoded, sampled, and released on
    /// the caller's executor without moving AppKit image objects across actors.
    static func extract(contentsOf urls: [URL]) -> SceneryPalette? {
        let pixels: [Pixel] = urls.prefix(maximumImageCount).flatMap { url -> [Pixel] in
            autoreleasepool { () -> [Pixel] in
                guard let data = try? Data(contentsOf: url),
                    let image = NSImage(data: data)
                else { return [] }
                return samplePixels(from: image)
            }
        }
        return makePalette(from: pixels)
    }

    private static func samplePixels(from image: NSImage) -> [Pixel] {
        var proposedRect = CGRect(origin: .zero, size: image.size)
        guard proposedRect.width > 0, proposedRect.height > 0,
            let source = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil)
        else { return [] }

        let bytesPerRow = bitmapSide * 4
        var bytes = [UInt8](repeating: 0, count: bitmapSide * bytesPerRow)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo =
            CGBitmapInfo.byteOrder32Big.rawValue
            | CGImageAlphaInfo.premultipliedLast.rawValue

        return bytes.withUnsafeMutableBytes { buffer in
            guard
                let context = CGContext(
                    data: buffer.baseAddress,
                    width: bitmapSide,
                    height: bitmapSide,
                    bitsPerComponent: 8,
                    bytesPerRow: bytesPerRow,
                    space: colorSpace,
                    bitmapInfo: bitmapInfo)
            else { return [] }

            context.interpolationQuality = .low
            context.setBlendMode(.copy)
            context.draw(
                source,
                in: CGRect(x: 0, y: 0, width: bitmapSide, height: bitmapSide))

            let values = buffer.bindMemory(to: UInt8.self)
            var pixels: [Pixel] = []
            pixels.reserveCapacity(bitmapSide * bitmapSide)
            for offset in stride(from: 0, to: values.count, by: 4) {
                let alpha = Double(values[offset + 3]) / 255
                guard alpha >= 0.5 else { continue }
                let divisor = max(alpha, 1.0 / 255)
                pixels.append(
                    Pixel(
                        red: min(Double(values[offset]) / 255 / divisor, 1),
                        green: min(Double(values[offset + 1]) / 255 / divisor, 1),
                        blue: min(Double(values[offset + 2]) / 255 / divisor, 1)))
            }
            return pixels
        }
    }

    private static func makePalette(from pixels: [Pixel]) -> SceneryPalette? {
        guard !pixels.isEmpty else { return nil }

        // Bucket by hue while retaining average saturation/brightness. A
        // separate neutral bucket avoids turning snow, fog, or stone red just
        // because achromatic HSV hue is reported as zero.
        var buckets = (0...hueBucketCount).map { HueBucket(index: $0) }
        for pixel in pixels {
            let hsb = rgbToHSB(red: pixel.red, green: pixel.green, blue: pixel.blue)
            guard hsb.brightness >= 0.06 else { continue }
            let index =
                hsb.saturation < 0.08
                ? hueBucketCount
                : min(Int(hsb.hue * Double(hueBucketCount)), hueBucketCount - 1)
            let chromaWeight = 0.28 + (hsb.saturation * 0.72)
            let exposureWeight = max(0.25, min(hsb.brightness * 1.25, 1))
            let circularWeight = max(hsb.saturation, 0.05)
            buckets[index].count += 1
            buckets[index].score += chromaWeight * exposureWeight
            buckets[index].hueX += cos(hsb.hue * 2 * .pi) * circularWeight
            buckets[index].hueY += sin(hsb.hue * 2 * .pi) * circularWeight
            buckets[index].saturationTotal += hsb.saturation
            buckets[index].brightnessTotal += hsb.brightness
        }

        let ranked = buckets.filter { $0.count > 0 }.sorted { lhs, rhs in
            if abs(lhs.score - rhs.score) > .ulpOfOne { return lhs.score > rhs.score }
            if lhs.count != rhs.count { return lhs.count > rhs.count }
            if abs(lhs.saturation - rhs.saturation) > .ulpOfOne {
                return lhs.saturation > rhs.saturation
            }
            return lhs.index < rhs.index
        }
        guard !ranked.isEmpty else { return nil }

        var dominant: [HueBucket] = []
        for candidate in ranked {
            let sufficientlyDistinct = dominant.allSatisfy {
                candidate.index == hueBucketCount || $0.index == hueBucketCount
                    || circularBucketDistance(candidate.index, $0.index) >= 2
            }
            if sufficientlyDistinct {
                dominant.append(candidate)
                if dominant.count == gradientPairCount { break }
            }
        }
        if dominant.count < gradientPairCount {
            for candidate in ranked where !dominant.contains(where: { $0.index == candidate.index }) {
                dominant.append(candidate)
                if dominant.count == gradientPairCount { break }
            }
        }

        let sourceCount = dominant.count
        let washes = (0..<gradientPairCount).map { index -> [String] in
            let source = dominant[index % sourceCount]
            let variation = Double(index / sourceCount) * 0.012
            if source.saturation < 0.08 {
                let dark = hsbToHex(
                    hue: 0, saturation: 0.04,
                    brightness: clamp(0.16 + source.brightness * 0.08 + variation, 0.16, 0.27))
                let wash = hsbToHex(
                    hue: 0, saturation: 0.03,
                    brightness: clamp(0.48 + source.brightness * 0.14 + variation, 0.48, 0.66))
                return [dark, wash]
            }

            let dark = hsbToHex(
                hue: source.hue,
                saturation: clamp(source.saturation * 0.72 + 0.10, 0.30, 0.68),
                brightness: clamp(0.14 + source.brightness * 0.12 + variation, 0.14, 0.29))
            let wash = hsbToHex(
                hue: source.hue,
                saturation: clamp(source.saturation * 0.52 + 0.08, 0.22, 0.56),
                brightness: clamp(0.46 + source.brightness * 0.18 + variation, 0.46, 0.68))
            return [dark, wash]
        }

        let accentSource = dominant.max { lhs, rhs in
            if abs(lhs.saturation - rhs.saturation) > .ulpOfOne {
                return lhs.saturation < rhs.saturation
            }
            if abs(lhs.score - rhs.score) > .ulpOfOne { return lhs.score < rhs.score }
            return lhs.index > rhs.index
        }
        let accentHex: String
        if let accentSource, accentSource.saturation >= 0.12 {
            accentHex = hsbToHex(
                hue: accentSource.hue,
                saturation: clamp(accentSource.saturation, 0.52, 0.78),
                brightness: clamp(accentSource.brightness, 0.60, 0.78))
        } else {
            // Neutral photo sets retain the established alpine moss accent.
            accentHex = "#4D755C"
        }

        return SceneryPalette(accentHex: accentHex, washes: washes)
    }

    private static func circularBucketDistance(_ lhs: Int, _ rhs: Int) -> Int {
        let direct = abs(lhs - rhs)
        return min(direct, hueBucketCount - direct)
    }

    private static func rgbToHSB(red: Double, green: Double, blue: Double) -> (
        hue: Double, saturation: Double, brightness: Double
    ) {
        let maximum = max(red, green, blue)
        let minimum = min(red, green, blue)
        let delta = maximum - minimum
        let saturation = maximum > 0 ? delta / maximum : 0
        guard delta > .ulpOfOne else { return (0, saturation, maximum) }

        let sector: Double
        if maximum == red {
            sector = ((green - blue) / delta).truncatingRemainder(dividingBy: 6)
        } else if maximum == green {
            sector = ((blue - red) / delta) + 2
        } else {
            sector = ((red - green) / delta) + 4
        }
        let hue = sector / 6
        return (hue >= 0 ? hue : hue + 1, saturation, maximum)
    }

    private static func hsbToHex(hue: Double, saturation: Double, brightness: Double) -> String {
        let h = (hue - floor(hue)) * 6
        let chroma = brightness * saturation
        let x = chroma * (1 - abs(h.truncatingRemainder(dividingBy: 2) - 1))
        let rgb: (Double, Double, Double)
        switch h {
        case 0..<1: rgb = (chroma, x, 0)
        case 1..<2: rgb = (x, chroma, 0)
        case 2..<3: rgb = (0, chroma, x)
        case 3..<4: rgb = (0, x, chroma)
        case 4..<5: rgb = (x, 0, chroma)
        default: rgb = (chroma, 0, x)
        }
        let match = brightness - chroma
        let red = Int(((rgb.0 + match) * 255).rounded())
        let green = Int(((rgb.1 + match) * 255).rounded())
        let blue = Int(((rgb.2 + match) * 255).rounded())
        return String(format: "#%02X%02X%02X", red, green, blue)
    }

    private static func clamp(_ value: Double, _ minimum: Double, _ maximum: Double) -> Double {
        min(max(value, minimum), maximum)
    }
}
