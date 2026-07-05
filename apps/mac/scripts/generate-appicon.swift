#!/usr/bin/env swift
// Generates Support/AppIcon.icns — a flat alpine-scenery icon (sky, sun,
// snow-capped ranges, pine foreground) drawn with CoreGraphics into the
// standard Big Sur squircle, then packed via `iconutil`. Re-run after any
// artwork tweak; the .icns is committed so normal builds never need this.
// Usage: swift scripts/generate-appicon.swift

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

func polygon(_ points: [(CGFloat, CGFloat)]) -> CGPath {
    let path = CGMutablePath()
    path.move(to: CGPoint(x: points[0].0, y: points[0].1))
    for p in points.dropFirst() { path.addLine(to: CGPoint(x: p.0, y: p.1)) }
    path.closeSubpath()
    return path
}

/// Rolling hill: baseline across the squircle with a curved ridge top.
func hill(ridge: [((CGFloat, CGFloat), (CGFloat, CGFloat))], start: CGPoint) -> CGPath {
    let path = CGMutablePath()
    path.move(to: CGPoint(x: 100, y: 100))
    path.addLine(to: start)
    for (control, end) in ridge {
        path.addQuadCurve(
            to: CGPoint(x: end.0, y: end.1),
            control: CGPoint(x: control.0, y: control.1))
    }
    path.addLine(to: CGPoint(x: 924, y: 100))
    path.closeSubpath()
    return path
}

func pine(at x: CGFloat, base y: CGFloat, height: CGFloat, into ctx: CGContext) {
    let w = height * 0.55
    ctx.setFillColor(srgb(0x16_3325))
    // Trunk, then three stacked canopy triangles.
    ctx.fill(CGRect(x: x - height * 0.04, y: y, width: height * 0.08, height: height * 0.16))
    for (i, span) in [(0.10, 0.55), (0.32, 0.78), (0.54, 1.0)].enumerated().reversed() {
        let tierW = w * (1.0 - CGFloat(i) * 0.28)
        ctx.addPath(
            polygon([
                (x - tierW / 2, y + height * CGFloat(span.0)),
                (x + tierW / 2, y + height * CGFloat(span.0)),
                (x, y + height * CGFloat(span.1)),
            ]))
        ctx.fillPath()
    }
}

func drawIcon(into ctx: CGContext, pixels: Int) {
    let s = CGFloat(pixels) / canvas
    ctx.scaleBy(x: s, y: s)

    // Big Sur icon grid: 824pt squircle centered on the 1024pt canvas.
    let squircle = CGPath(
        roundedRect: CGRect(x: 100, y: 100, width: 824, height: 824),
        cornerWidth: 185, cornerHeight: 185, transform: nil)
    ctx.addPath(squircle)
    ctx.clip()

    // Sky: deep alpine blue into a warm horizon band.
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let sky = CGGradient(
        colorsSpace: space,
        colors: [srgb(0x2F_6BB0), srgb(0x8A_BCE2), srgb(0xF4_E7C6)] as CFArray,
        locations: [0, 0.55, 1])!
    ctx.drawLinearGradient(
        sky, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 440), options: [])
    ctx.setFillColor(srgb(0xF4_E7C6))
    ctx.fill(CGRect(x: 100, y: 100, width: 824, height: 340))

    // Sun with a soft halo, upper right.
    let sunCenter = CGPoint(x: 706, y: 700)
    let halo = CGGradient(
        colorsSpace: space,
        colors: [srgb(0xFF_EFB0, 0.55), srgb(0xFF_EFB0, 0.0)] as CFArray,
        locations: [0, 1])!
    ctx.drawRadialGradient(
        halo, startCenter: sunCenter, startRadius: 0,
        endCenter: sunCenter, endRadius: 165, options: [])
    ctx.setFillColor(srgb(0xFF_E9A3))
    ctx.fillEllipse(in: CGRect(x: sunCenter.x - 66, y: sunCenter.y - 66, width: 132, height: 132))

    // Far range — hazy blue with snow caps on each peak.
    let farPeaks: [(CGFloat, CGFloat)] = [(196, 636), (410, 722), (628, 668), (852, 648)]
    var farRidge: [(CGFloat, CGFloat)] = [(100, 500)]
    let farValleys: [(CGFloat, CGFloat)] = [(300, 552), (516, 566), (744, 560), (924, 584)]
    for i in 0..<farPeaks.count {
        farRidge.append(farPeaks[i])
        farRidge.append(farValleys[i])
    }
    farRidge.append((924, 430))
    farRidge.append((100, 430))
    ctx.setFillColor(srgb(0xA3_BFD9))
    ctx.addPath(polygon(farRidge))
    ctx.fillPath()
    ctx.setFillColor(srgb(0xF2_F7FB))
    for peak in farPeaks {
        // Snow cap: small jagged triangle hugging the peak's slopes.
        ctx.addPath(
            polygon([
                peak,
                (peak.0 + 40, peak.1 - 56),
                (peak.0 + 16, peak.1 - 44),
                (peak.0, peak.1 - 58),
                (peak.0 - 16, peak.1 - 44),
                (peak.0 - 40, peak.1 - 56),
            ]))
        ctx.fillPath()
    }

    // Mid range — deeper slate blue.
    ctx.setFillColor(srgb(0x5E_88A8))
    ctx.addPath(
        polygon([
            (100, 452), (248, 592), (372, 512), (536, 630), (692, 528),
            (828, 596), (924, 508), (924, 360), (100, 360),
        ]))
    ctx.fillPath()

    // Rolling green hills, then a darker foreground hill with pines.
    ctx.setFillColor(srgb(0x40_7257))
    ctx.addPath(
        hill(
            ridge: [((300, 512), (520, 448)), ((740, 396), (924, 452))],
            start: CGPoint(x: 100, y: 436)))
    ctx.fillPath()

    ctx.setFillColor(srgb(0x2B_5743))
    ctx.addPath(
        hill(
            ridge: [((320, 414), (580, 330)), ((770, 282), (924, 350))],
            start: CGPoint(x: 100, y: 346)))
    ctx.fillPath()

    for (x, y, h) in [(232, 322, 128), (318, 340, 96), (700, 268, 118), (788, 292, 88)] {
        pine(at: CGFloat(x), base: CGFloat(y), height: CGFloat(h), into: ctx)
    }

    // Faint top sheen so the flat artwork sits well on Liquid Glass shelves.
    let sheen = CGGradient(
        colorsSpace: space,
        colors: [srgb(0xFF_FFFF, 0.18), srgb(0xFF_FFFF, 0.0)] as CFArray,
        locations: [0, 1])!
    ctx.drawLinearGradient(
        sheen, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 700), options: [])
}

func render(pixels: Int, to url: URL) {
    let ctx = CGContext(
        data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    drawIcon(into: ctx, pixels: pixels)
    let image = ctx.makeImage()!
    let dest = CGImageDestinationCreateWithURL(
        url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("PNG write failed: \(url.path)") }
}

let scriptDir = URL(fileURLWithPath: CommandLine.arguments[0])
    .resolvingSymlinksInPath().deletingLastPathComponent()
let macDir = scriptDir.deletingLastPathComponent()
let iconset = macDir.appendingPathComponent("dist/AppIcon.iconset")
let fm = FileManager.default
try? fm.removeItem(at: iconset)
try fm.createDirectory(at: iconset, withIntermediateDirectories: true)

for (name, pixels) in [
    ("icon_16x16", 16), ("icon_16x16@2x", 32),
    ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256),
    ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
] {
    render(pixels: pixels, to: iconset.appendingPathComponent("\(name).png"))
}

let icns = macDir.appendingPathComponent("Support/AppIcon.icns")
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", icns.path]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else { fatalError("iconutil failed") }
print("Wrote \(icns.path)")
