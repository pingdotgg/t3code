// Generates the shipped blue Support/AppIcon.icns from the canonical
// passportPeak geometry in BrandMarkGeometry.swift.
// Run from apps/mac with the geometry file compiled into the script:
//   swiftc -O scripts/generate-appicon.swift Sources/SergeCodeMac/Theme/BrandMarkGeometry.swift -o /tmp/generate-appicon
//   /tmp/generate-appicon
//   /tmp/generate-appicon --emit-svg Support/AppIcon.icon/Assets/mark.svg
//
// The .icon bundles are source for Apple Icon Composer. There is no `icontool`
// on this machine, so the generated .icns files remain the shipped artifacts.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// All geometry is authored on a 1024pt canvas and scaled per output size.
let canvas: CGFloat = 1024

func srgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(
        colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        components: [
            CGFloat((hex >> 16) & 0xFF) / 255,
            CGFloat((hex >> 8) & 0xFF) / 255,
            CGFloat(hex & 0xFF) / 255,
            alpha,
        ])!
}

private func squircleRect() -> CGRect {
    CGRect(x: 100, y: 100, width: 824, height: 824)
}

private func markRect(in squircle: CGRect) -> CGRect {
    let side = squircle.width * 0.65
    return CGRect(
        x: squircle.midX - side / 2,
        y: squircle.midY - side / 2 - squircle.height * 0.02,
        width: side,
        height: side)
}

private func drawTopSheen(into ctx: CGContext, space: CGColorSpace) {
    let sheen = CGGradient(
        colorsSpace: space,
        colors: [srgb(0xFF_FFFF, 0.18), srgb(0xFF_FFFF, 0.0)] as CFArray,
        locations: [0, 1])!
    ctx.drawLinearGradient(
        sheen,
        start: CGPoint(x: 512, y: 924),
        end: CGPoint(x: 512, y: 700),
        options: [])
}

private func drawBackground(
    squircle: CGRect,
    into ctx: CGContext,
    space: CGColorSpace
) {
    let sky = CGGradient(
        colorsSpace: space,
        colors: BrandMarkGeometry.skyStops.map { $0.cgColor() } as CFArray,
        locations: [0, 0.55, 1])!
    ctx.drawLinearGradient(
        sky,
        start: CGPoint(x: 512, y: squircle.maxY),
        end: CGPoint(x: 512, y: squircle.minY),
        options: [])

    // A restrained highlight keeps the flat artwork legible on Liquid Glass
    // shelves without changing the palette or obscuring the mark.
    drawTopSheen(into: ctx, space: space)
}

private func drawIcon(into ctx: CGContext, pixels: Int) {
    let scale = CGFloat(pixels) / canvas
    ctx.scaleBy(x: scale, y: scale)

    let squircle = squircleRect()
    let squirclePath = CGPath(
        roundedRect: squircle,
        cornerWidth: 185,
        cornerHeight: 185,
        transform: nil)

    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    ctx.saveGState()
    ctx.addPath(squirclePath)
    ctx.clip()
    drawBackground(squircle: squircle, into: ctx, space: space)

    // BrandMarkGeometry uses top-left coordinates like SwiftUI. Bitmap
    // contexts use a bottom-left origin, so flip only the mark drawing.
    let mark = BrandMarkGeometry.silhouette(.passportPeak, in: markRect(in: squircle))
    ctx.saveGState()
    ctx.translateBy(x: 0, y: canvas)
    ctx.scaleBy(x: 1, y: -1)
    ctx.setShadow(
        offset: CGSize(width: 0, height: -8),
        blur: 18,
        color: srgb(0x00_0000, 0.25))
    ctx.setFillColor(BrandMarkGeometry.snow.cgColor())
    ctx.addPath(mark)
    ctx.drawPath(using: .eoFill)
    ctx.restoreGState()
    ctx.restoreGState()
}

private func render(pixels: Int, to url: URL) {
    guard let ctx = CGContext(
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

    drawIcon(into: ctx, pixels: pixels)
    guard let image = ctx.makeImage() else {
        fatalError("Could not create \(pixels)x\(pixels) CGImage")
    }
    guard let destination = CGImageDestinationCreateWithURL(
        url as CFURL,
        UTType.png.identifier as CFString,
        1,
        nil
    ) else {
        fatalError("Could not create PNG destination at \(url.path)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        fatalError("PNG write failed: \(url.path)")
    }
}

private func svgNumber(_ value: CGFloat) -> String {
    let number = abs(Double(value)) < 0.0005 ? 0 : Double(value)
    return String(format: "%.3f", locale: Locale(identifier: "en_US_POSIX"), number)
        .replacingOccurrences(of: #"\.?0+$"#, with: "", options: .regularExpression)
}

private func svgPathData(for path: CGPath) -> String {
    var commands: [String] = []
    path.applyWithBlock { elementPointer in
        let element = elementPointer.pointee
        let points = element.points
        switch element.type {
        case .moveToPoint:
            commands.append("M \(svgNumber(points[0].x)) \(svgNumber(points[0].y))")
        case .addLineToPoint:
            commands.append("L \(svgNumber(points[0].x)) \(svgNumber(points[0].y))")
        case .addQuadCurveToPoint:
            commands.append(
                "Q \(svgNumber(points[0].x)) \(svgNumber(points[0].y)) \(svgNumber(points[1].x)) \(svgNumber(points[1].y))")
        case .addCurveToPoint:
            commands.append(
                "C \(svgNumber(points[0].x)) \(svgNumber(points[0].y)) \(svgNumber(points[1].x)) \(svgNumber(points[1].y)) \(svgNumber(points[2].x)) \(svgNumber(points[2].y))")
        case .closeSubpath:
            commands.append("Z")
        @unknown default:
            break
        }
    }
    return commands.joined(separator: " ")
}

private func writeSVG(to path: String, baseDirectory: URL, fileManager: FileManager) {
    let outputURL = URL(fileURLWithPath: path, relativeTo: baseDirectory).standardizedFileURL
    let mark = BrandMarkGeometry.silhouette(.passportPeak, in: markRect(in: squircleRect()))
    let svg = """
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
      <path d="\(svgPathData(for: mark))" fill="#F2F7FB" fill-rule="evenodd"/>
    </svg>
    """ + "\n"

    do {
        try fileManager.createDirectory(
            at: outputURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try svg.write(to: outputURL, atomically: true, encoding: .utf8)
    } catch {
        fatalError("SVG write failed at \(outputURL.path): \(error)")
    }
    print("Wrote \(outputURL.path)")
}

@main
struct GenerateAppIcon {
    static func main() {
        let fileManager = FileManager.default
        let arguments = Array(CommandLine.arguments.dropFirst())
        var svgPath: String?
        var argumentIndex = 0

        while argumentIndex < arguments.count {
            switch arguments[argumentIndex] {
            case "--emit-svg":
                argumentIndex += 1
                guard argumentIndex < arguments.count else {
                    fatalError("Usage: generate-appicon [--emit-svg <path>]")
                }
                svgPath = arguments[argumentIndex]

            default:
                fatalError("Unknown argument \(arguments[argumentIndex])")
            }
            argumentIndex += 1
        }

        let workingDirectory = URL(fileURLWithPath: fileManager.currentDirectoryPath, isDirectory: true)
        let macDirectory: URL
        if workingDirectory.lastPathComponent == "mac" {
            macDirectory = workingDirectory
        } else {
            let nestedMacDirectory = workingDirectory.appendingPathComponent("apps/mac", isDirectory: true)
            guard fileManager.fileExists(
                atPath: nestedMacDirectory.appendingPathComponent("Sources/SergeCodeMac/Theme/BrandMarkGeometry.swift").path) else {
                fatalError("Run this tool from the repository root or apps/mac")
            }
            macDirectory = nestedMacDirectory
        }

        if let svgPath {
            writeSVG(to: svgPath, baseDirectory: macDirectory, fileManager: fileManager)
        } else {
            let distDirectory = macDirectory.appendingPathComponent("dist", isDirectory: true)
            let iconset = distDirectory.appendingPathComponent("AppIcon.iconset", isDirectory: true)
            try? fileManager.removeItem(at: iconset)
            do {
                try fileManager.createDirectory(at: iconset, withIntermediateDirectories: true)
            } catch {
                fatalError("Could not create iconset directory \(iconset.path): \(error)")
            }

            for (name, pixels) in [
                ("icon_16x16", 16), ("icon_16x16@2x", 32),
                ("icon_32x32", 32), ("icon_32x32@2x", 64),
                ("icon_128x128", 128), ("icon_128x128@2x", 256),
                ("icon_256x256", 256), ("icon_256x256@2x", 512),
                ("icon_512x512", 512), ("icon_512x512@2x", 1024),
            ] {
                render(pixels: pixels, to: iconset.appendingPathComponent("\(name).png"))
            }

            let icns = macDirectory.appendingPathComponent("Support", isDirectory: true)
                .appendingPathComponent("AppIcon.icns")
            try? fileManager.removeItem(at: icns)
            let iconutil = Process()
            iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
            iconutil.arguments = ["-c", "icns", iconset.path, "-o", icns.path]
            do {
                try iconutil.run()
                iconutil.waitUntilExit()
            } catch {
                fatalError("Could not run iconutil: \(error)")
            }
            guard iconutil.terminationStatus == 0 else {
                fatalError("iconutil failed with exit code \(iconutil.terminationStatus)")
            }
            print("iconutil exited 0")
            print("Wrote \(icns.path)")
        }
    }
}
