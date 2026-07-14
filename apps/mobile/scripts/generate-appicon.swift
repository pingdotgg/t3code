#!/usr/bin/env swift
// Generates the mobile app icon family from the canonical passportPeak mark.
//
// The mobile outputs stay full-bleed squares so iOS and Android can apply their
// platform masks. Android adaptive-icon layers receive the same art inset to
// the central safe zone. `--variant dev` switches to the dev palette, matching
// apps/mac/scripts/generate-appicon.swift; the default is the production mark.
//
// Writes (paths relative to this script's directory):
//   ../assets/icon.png                     1024x1024, full bleed
//   ../assets/splash-icon.png              1024x1024, full bleed
//   ../assets/android-icon-foreground.png  432x432, inset to the central 66%
//   ../assets/android-icon-background.png  432x432, inset to the central 66%
//   ../assets/android-icon-monochrome.png  432x432, inset to the central 66%
//
// Usage: swift scripts/generate-appicon.swift [--variant prod|dev]

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let canvas: CGFloat = 1024
let authoringBox = CGRect(x: 100, y: 100, width: 824, height: 824)

enum IconVariant: String {
    case production = "prod"
    case dev

    var markColor: CGColor {
        switch self {
        case .production:
            return srgb(0xF2_F7_FB)
        case .dev:
            return srgb(0x8F_BF_9F)
        }
    }

    var backgroundColor: CGColor {
        switch self {
        case .production:
            return srgb(0x2F_6BB0)
        case .dev:
            return srgb(0x16_3325)
        }
    }
}

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

func passportPeakPath(in rect: CGRect) -> CGPath {
    let bounds = rect.standardized
    let side = min(bounds.width, bounds.height)
    let square = CGRect(
        x: bounds.midX - side / 2,
        y: bounds.midY - side / 2,
        width: side,
        height: side)
    let path = CGMutablePath()
    let ringThickness = square.width * 0.082
    path.addEllipse(in: square)
    path.addEllipse(in: square.insetBy(dx: ringThickness, dy: ringThickness))

    func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
        CGPoint(x: square.minX + square.width * x, y: square.minY + square.height * y)
    }

    path.move(to: point(0.20, 0.72))
    path.addLine(to: point(0.38, 0.48))
    path.addLine(to: point(0.50, 0.72))
    path.closeSubpath()

    path.move(to: point(0.50, 0.72))
    path.addLine(to: point(0.62, 0.32))
    path.addLine(to: point(0.80, 0.72))
    path.closeSubpath()
    return path
}

func drawBackground(variant: IconVariant, into ctx: CGContext) {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    switch variant {
    case .production:
        let sky = CGGradient(
            colorsSpace: space,
            colors: [
                srgb(0x2F_6BB0),
                srgb(0x8A_BCE2),
                srgb(0xF4_E7C6),
            ] as CFArray,
            locations: [0, 0.55, 1])!
        ctx.drawLinearGradient(
            sky,
            start: CGPoint(x: canvas / 2, y: canvas),
            end: CGPoint(x: canvas / 2, y: 0),
            options: [])
    case .dev:
        ctx.setFillColor(variant.backgroundColor)
        ctx.fill(CGRect(x: 0, y: 0, width: canvas, height: canvas))

        let vignette = CGGradient(
            colorsSpace: space,
            colors: [srgb(0x00_0000, 0), srgb(0x00_0000, 0.30)] as CFArray,
            locations: [0, 1])!
        ctx.drawRadialGradient(
            vignette,
            startCenter: CGPoint(x: canvas / 2, y: canvas / 2),
            startRadius: 0,
            endCenter: CGPoint(x: canvas / 2, y: canvas / 2),
            endRadius: canvas * 0.78,
            options: [])
    }

    let sheen = CGGradient(
        colorsSpace: space,
        colors: [srgb(0xFF_FFFF, 0.18), srgb(0xFF_FFFF, 0)] as CFArray,
        locations: [0, 1])!
    ctx.drawLinearGradient(
        sheen,
        start: CGPoint(x: canvas / 2, y: canvas),
        end: CGPoint(x: canvas / 2, y: canvas * 0.78),
        options: [])
}

func drawArt(variant: IconVariant, into ctx: CGContext) {
    drawBackground(variant: variant, into: ctx)

    let markSide = authoringBox.width * 0.65
    let markRect = CGRect(
        x: authoringBox.midX - markSide / 2,
        y: authoringBox.midY - markSide / 2 - authoringBox.height * 0.02,
        width: markSide,
        height: markSide)
    let mark = passportPeakPath(in: markRect)

    // BrandMarkGeometry uses top-left coordinates. Flip only the mark for the
    // bottom-left bitmap context, preserving the canonical orientation.
    ctx.saveGState()
    ctx.translateBy(x: 0, y: canvas)
    ctx.scaleBy(x: 1, y: -1)
    ctx.setShadow(offset: CGSize(width: 0, height: -8), blur: 18, color: srgb(0x00_0000, 0.25))
    ctx.setFillColor(variant.markColor)
    ctx.addPath(mark)
    ctx.drawPath(using: .eoFill)
    ctx.restoreGState()
}

func render(
    pixels: Int,
    targetRect: CGRect,
    variant: IconVariant,
    to url: URL
) {
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

    let pixelScale = CGFloat(pixels) / canvas
    let targetScale = targetRect.width / canvas
    ctx.scaleBy(x: pixelScale, y: pixelScale)
    ctx.translateBy(x: targetRect.origin.x, y: targetRect.origin.y)
    ctx.scaleBy(x: targetScale, y: targetScale)
    drawArt(variant: variant, into: ctx)

    guard let image = ctx.makeImage(),
          let destination = CGImageDestinationCreateWithURL(
              url as CFURL,
              UTType.png.identifier as CFString,
              1,
              nil) else {
        fatalError("Could not create PNG destination at \(url.path)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        fatalError("PNG write failed: \(url.path)")
    }
    print("Wrote \(url.path) (\(pixels)x\(pixels), \(variant.rawValue))")
}

func renderFullBleed(pixels: Int, variant: IconVariant, to url: URL) {
    render(
        pixels: pixels,
        targetRect: CGRect(x: 0, y: 0, width: canvas, height: canvas),
        variant: variant,
        to: url)
}

func renderInset(pixels: Int, safeZoneFraction: CGFloat, variant: IconVariant, to url: URL) {
    let inset = canvas * safeZoneFraction
    let margin = (canvas - inset) / 2
    render(
        pixels: pixels,
        targetRect: CGRect(x: margin, y: margin, width: inset, height: inset),
        variant: variant,
        to: url)
}

let arguments = Array(CommandLine.arguments.dropFirst())
var variant = IconVariant.production
var index = 0
while index < arguments.count {
    guard arguments[index] == "--variant", index + 1 < arguments.count,
          let parsed = IconVariant(rawValue: arguments[index + 1]) else {
        fatalError("Usage: generate-appicon.swift [--variant prod|dev]")
    }
    variant = parsed
    index += 2
}

let scriptDir = URL(fileURLWithPath: CommandLine.arguments[0])
    .resolvingSymlinksInPath()
    .deletingLastPathComponent()
let assetsDir = scriptDir.deletingLastPathComponent().appendingPathComponent("assets")

renderFullBleed(pixels: 1024, variant: variant, to: assetsDir.appendingPathComponent("icon.png"))
renderFullBleed(pixels: 1024, variant: variant, to: assetsDir.appendingPathComponent("splash-icon.png"))
for name in [
    "android-icon-foreground.png",
    "android-icon-background.png",
    "android-icon-monochrome.png",
] {
    renderInset(
        pixels: 432,
        safeZoneFraction: 0.66,
        variant: variant,
        to: assetsDir.appendingPathComponent(name))
}
