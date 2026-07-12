// Renders a contact sheet for the three SurgeCode brand-mark candidates.
// Usage (from apps/mac):
//   swiftc -O scripts/preview-mark.swift Sources/SergeCodeMac/Theme/BrandMarkGeometry.swift -o /tmp/preview-mark && /tmp/preview-mark

import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

private enum Background: CaseIterable {
    case light
    case dark
    case checkerboard

    var title: String {
        switch self {
        case .light: return "light #F5F5F7"
        case .dark: return "dark #1D1D1F"
        case .checkerboard: return "checkerboard"
        }
    }
}

private enum MarkStyle: CaseIterable {
    case monochrome
    case fullColor

    var title: String {
        switch self {
        case .monochrome: return "mono"
        case .fullColor: return "fullColor"
        }
    }
}

private let sizes = [16, 32, 128, 512]
private let candidates = BrandMarkCandidate.allCases
private let canvasWidth = 2_620
private let canvasHeight = 1_130
private let labelColumnWidth: CGFloat = 180
private let groupWidth: CGFloat = 805
private let rowHeight: CGFloat = 350
private let pagePadding: CGFloat = 28

private func color(_ rgb: BrandMarkGeometry.RGB, alpha: CGFloat = 1) -> CGColor {
    rgb.cgColor(alpha: alpha)
}

private func flatColor(_ hex: UInt32, alpha: CGFloat = 1) -> CGColor {
    CGColor(
        colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        components: [
            CGFloat((hex >> 16) & 0xFF) / 255,
            CGFloat((hex >> 8) & 0xFF) / 255,
            CGFloat(hex & 0xFF) / 255,
            alpha,
        ])!
}

private func drawText(
    _ string: String,
    at point: CGPoint,
    size: CGFloat,
    color: CGColor,
    in context: CGContext
) {
    let font = CTFontCreateWithName("HelveticaNeue" as CFString, size, nil)
    let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(rawValue: "NSFont"): font,
        NSAttributedString.Key(rawValue: "NSColor"): color,
    ]
    let line = CTLineCreateWithAttributedString(
        NSAttributedString(string: string, attributes: attributes))
    context.textPosition = point
    CTLineDraw(line, context)
}

private func drawBackground(
    _ background: Background,
    in rect: CGRect,
    context: CGContext,
    checkerCell: CGFloat = 16
) {
    switch background {
    case .light:
        context.setFillColor(flatColor(0xF5F5F7))
        context.fill(rect)

    case .dark:
        context.setFillColor(flatColor(0x1D1D1F))
        context.fill(rect)

    case .checkerboard:
        context.saveGState()
        context.clip(to: rect)
        context.setFillColor(flatColor(0xF5F5F7))
        context.fill(rect)
        context.setFillColor(flatColor(0xD3D4D7))
        let columns = Int(ceil(rect.width / checkerCell))
        let rows = Int(ceil(rect.height / checkerCell))
        for row in 0...rows {
            for column in 0...columns where (row + column).isMultiple(of: 2) {
                context.fill(CGRect(
                    x: rect.minX + CGFloat(column) * checkerCell,
                    y: rect.minY + CGFloat(row) * checkerCell,
                    width: checkerCell,
                    height: checkerCell))
            }
        }
        context.restoreGState()
    }
}

private func renderMark(
    candidate: BrandMarkCandidate,
    size: Int,
    style: MarkStyle,
    background: Background
) -> CGImage {
    let pixels = max(1, size)
    guard let context = CGContext(
        data: nil,
        width: pixels,
        height: pixels,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        fatalError("Could not create \(pixels)x\(pixels) sRGB bitmap context")
    }

    let imageRect = CGRect(x: 0, y: 0, width: pixels, height: pixels)
    drawBackground(background, in: imageRect, context: context, checkerCell: max(2, CGFloat(pixels) / 8))

    // BrandMarkGeometry uses top-left coordinates like SwiftUI. Bitmap
    // contexts use a bottom-left origin, so flip only the mark drawing.
    context.saveGState()
    context.translateBy(x: 0, y: CGFloat(pixels))
    context.scaleBy(x: 1, y: -1)

    let silhouette = BrandMarkGeometry.silhouette(candidate, in: imageRect)
    let moss = color(BrandMarkGeometry.moss)
    let snow = color(BrandMarkGeometry.snow)

    switch style {
    case .monochrome:
        context.setFillColor(moss)
        context.addPath(silhouette)
        if let accent = BrandMarkGeometry.accent(candidate, in: imageRect) {
            context.addPath(accent)
            context.drawPath(using: .eoFill)
        } else {
            let usesEvenOdd = candidate != .surgePeak
            context.drawPath(using: usesEvenOdd ? .eoFill : .fill)
        }

    case .fullColor:
        context.setFillColor(moss)
        context.addPath(silhouette)
        let usesEvenOdd = candidate != .surgePeak
        context.drawPath(using: usesEvenOdd ? .eoFill : .fill)

        if let accent = BrandMarkGeometry.accent(candidate, in: imageRect) {
            context.setFillColor(snow)
            context.addPath(accent)
            context.drawPath(using: .fill)
        }
    }

    context.restoreGState()
    guard let image = context.makeImage() else {
        fatalError("Could not create \(pixels)x\(pixels) CGImage")
    }
    return image
}

private func drawImage(
    _ image: CGImage,
    in rect: CGRect,
    interpolation: CGInterpolationQuality,
    context: CGContext
) {
    context.saveGState()
    context.interpolationQuality = interpolation
    context.draw(image, in: rect)
    context.restoreGState()
}

private func drawCell(
    candidate: BrandMarkCandidate,
    size: Int,
    style: MarkStyle,
    background: Background,
    in rect: CGRect,
    context: CGContext
) {
    drawBackground(background, in: rect, context: context, checkerCell: 16)

    let image = renderMark(candidate: candidate, size: size, style: style, background: background)
    let displaySize: CGFloat
    let interpolation: CGInterpolationQuality
    switch size {
    case 16, 32:
        displaySize = 96
        interpolation = .none
    case 128:
        displaySize = 128
        interpolation = .high
    default:
        displaySize = 128
        interpolation = .high
    }

    let displayRect = CGRect(
        x: rect.midX - displaySize / 2,
        y: rect.midY - displaySize / 2 + 7,
        width: displaySize,
        height: displaySize)
    drawImage(image, in: displayRect, interpolation: interpolation, context: context)

    if size == 16 || size == 32 {
        let trueSize = CGFloat(size)
        let trueRect = CGRect(
            x: rect.maxX - trueSize - 9,
            y: rect.minY + 9,
            width: trueSize,
            height: trueSize)
        drawImage(image, in: trueRect, interpolation: .none, context: context)
        drawText("true", at: CGPoint(x: trueRect.minX - 2, y: trueRect.maxY + 4), size: 9, color: flatColor(0x62646A), in: context)
    }
}

private func drawCandidateRow(
    _ candidate: BrandMarkCandidate,
    row: Int,
    in context: CGContext
) {
    let canvasHeightValue = CGFloat(canvasHeight)
    let top = canvasHeightValue - pagePadding - 58 - CGFloat(row) * rowHeight
    let labelColor = flatColor(0x163325)
    drawText(candidate.rawValue, at: CGPoint(x: pagePadding, y: top - rowHeight / 2 + 10), size: 18, color: labelColor, in: context)
    drawText("geometry", at: CGPoint(x: pagePadding, y: top - rowHeight / 2 - 13), size: 10, color: flatColor(0x70737A), in: context)

    for (backgroundIndex, background) in Background.allCases.enumerated() {
        let groupX = labelColumnWidth + pagePadding + CGFloat(backgroundIndex) * groupWidth
        drawText(
            background.title,
            at: CGPoint(x: groupX, y: top),
            size: 12,
            color: flatColor(0x45474D),
            in: context)

        let cellTop = top - 24
        let cellWidth: CGFloat = 177
        let cellHeight: CGFloat = 130
        let columnGap: CGFloat = 18
        for (sizeIndex, size) in sizes.enumerated() {
            let x = groupX + CGFloat(sizeIndex) * (cellWidth + columnGap)
            drawText("\(size)px", at: CGPoint(x: x, y: cellTop + 8), size: 11, color: background == .dark ? flatColor(0xFFFFFF) : flatColor(0x45474D), in: context)

            for (styleIndex, style) in MarkStyle.allCases.enumerated() {
                let y = cellTop - CGFloat(styleIndex) * (cellHeight + 18)
                let cellRect = CGRect(x: x, y: y - cellHeight, width: cellWidth, height: cellHeight)
                drawCell(candidate: candidate, size: size, style: style, background: background, in: cellRect, context: context)
                drawText(style.title, at: CGPoint(x: x + 7, y: y - cellHeight + 8), size: 10, color: background == .dark ? flatColor(0xFFFFFF) : flatColor(0x45474D), in: context)
            }
        }
    }
}

@main
struct PreviewMark {
    static func main() {
        let fileManager = FileManager.default
        let macDirectory = URL(fileURLWithPath: fileManager.currentDirectoryPath, isDirectory: true)
        let outputDirectory = macDirectory.appendingPathComponent("dist", isDirectory: true)
        let outputURL = outputDirectory.appendingPathComponent("mark-preview.png")

        do {
            try fileManager.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
        } catch {
            fatalError("Could not create output directory \(outputDirectory.path): \(error)")
        }

        guard let context = CGContext(
            data: nil,
            width: canvasWidth,
            height: canvasHeight,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            fatalError("Could not create contact-sheet bitmap context")
        }

        let canvasRect = CGRect(x: 0, y: 0, width: canvasWidth, height: canvasHeight)
        let canvasHeightValue = CGFloat(canvasHeight)
        context.setFillColor(flatColor(0xFFFFFF))
        context.fill(canvasRect)
        drawText("SurgeCode brand mark candidates", at: CGPoint(x: pagePadding, y: canvasHeightValue - pagePadding - 22), size: 24, color: flatColor(0x163325), in: context)
        drawText("native geometry • monochrome + fullColor • 16 / 32 / 128 / 512 px", at: CGPoint(x: pagePadding, y: canvasHeightValue - pagePadding - 42), size: 11, color: flatColor(0x70737A), in: context)

        for (row, candidate) in candidates.enumerated() {
            drawCandidateRow(candidate, row: row, in: context)
        }

        guard let image = context.makeImage() else {
            fatalError("Could not create contact-sheet image")
        }
        guard let destination = CGImageDestinationCreateWithURL(
            outputURL as CFURL,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else {
            fatalError("Could not create PNG destination at \(outputURL.path)")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            fatalError("PNG write failed: \(outputURL.path)")
        }
        print("Wrote \(outputURL.path)")
    }
}
