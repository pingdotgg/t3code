#!/usr/bin/env swift
// Generates the mobile app icon family — the same flat alpine-scenery mark
// (sky, sun, snow-capped ranges, pine foreground) as
// apps/mac/scripts/generate-appicon.swift, drawn with CoreGraphics.
//
// Unlike the mac script, these outputs are full-bleed 1024x1024 squares with
// no rounded-rect mask baked in — iOS/Android apply their own platform mask
// at render time, so pre-clipping to a squircle here would double-mask and
// leave dead transparent corners.
//
// Writes (paths relative to this script's directory):
//   ../assets/icon.png                     1024x1024, full bleed
//   ../assets/splash-icon.png              1024x1024, full bleed (same art)
//   ../assets/favicon.png                  180x180,  full bleed
//   ../assets/android-icon-foreground.png  432x432,  inset to the central 66%
//   ../assets/android-icon-background.png  432x432,  inset to the central 66%
//   ../assets/android-icon-monochrome.png  432x432,  inset to the central 66%
//
// The three android-icon-*.png outputs are intentionally identical (mirrors
// the pre-existing assets, which reused one image across all three slots).
// Android's adaptive-icon safe zone is a centered circle inside the 108dp
// icon; insetting the art to the central 66% keeps it clear of that mask.
//
// Usage: swift scripts/generate-appicon.swift

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// All geometry is authored on a 1024pt canvas, in a 100...924 box (the same
// box the mac script clips to a squircle) and mapped onto whatever square
// output region a given render pass asks for.
let canvas: CGFloat = 1024
let boxOrigin: CGFloat = 100
let boxSize: CGFloat = 824

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

/// Rolling hill: baseline across the box with a curved ridge top.
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

/// Paints the alpine mark in the fixed 100...924 authoring box. Callers set
/// up the CTM beforehand to map that box onto whatever output region they
/// need (full bleed, or an inset safe zone).
func drawArt(into ctx: CGContext) {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!

    // Sky: deep alpine blue into a warm horizon band.
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

/// Renders `drawArt`'s 100...924 authoring box into `targetRect`, expressed
/// in 0...1024 canvas coordinates, at `pixels` output resolution.
func render(pixels: Int, targetRect: CGRect, to url: URL) {
    let ctx = CGContext(
        data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!

    let pixelScale = CGFloat(pixels) / canvas
    let boxScale = targetRect.width / boxSize

    // CoreGraphics prepends each transform, so the most-recently-called one
    // applies first to raw drawArt coordinates: shift the 100...924 box to
    // the origin, scale it to targetRect's size, then place it at
    // targetRect's origin, then finally scale the whole canvas to pixels.
    ctx.scaleBy(x: pixelScale, y: pixelScale)
    ctx.translateBy(x: targetRect.origin.x, y: targetRect.origin.y)
    ctx.scaleBy(x: boxScale, y: boxScale)
    ctx.translateBy(x: -boxOrigin, y: -boxOrigin)

    drawArt(into: ctx)

    let image = ctx.makeImage()!
    let dest = CGImageDestinationCreateWithURL(
        url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("PNG write failed: \(url.path)") }
    print("Wrote \(url.path) (\(pixels)x\(pixels))")
}

func renderFullBleed(pixels: Int, to url: URL) {
    render(pixels: pixels, targetRect: CGRect(x: 0, y: 0, width: canvas, height: canvas), to: url)
}

/// Renders the art inset to the central `safeZoneFraction` of the canvas,
/// leaving transparent padding around it — for Android adaptive-icon layers,
/// which are masked to a safe-zone circle well inside the full square.
func renderInset(pixels: Int, safeZoneFraction: CGFloat, to url: URL) {
    let inset = canvas * safeZoneFraction
    let margin = (canvas - inset) / 2
    render(
        pixels: pixels,
        targetRect: CGRect(x: margin, y: margin, width: inset, height: inset),
        to: url)
}

let scriptDir = URL(fileURLWithPath: CommandLine.arguments[0])
    .resolvingSymlinksInPath().deletingLastPathComponent()
let assetsDir = scriptDir.deletingLastPathComponent().appendingPathComponent("assets")

renderFullBleed(pixels: 1024, to: assetsDir.appendingPathComponent("icon.png"))
renderFullBleed(pixels: 1024, to: assetsDir.appendingPathComponent("splash-icon.png"))
renderFullBleed(pixels: 180, to: assetsDir.appendingPathComponent("favicon.png"))

// Android adaptive-icon safe zone: keep the mark within the central 66%.
for name in ["android-icon-foreground.png", "android-icon-background.png", "android-icon-monochrome.png"] {
    renderInset(pixels: 432, safeZoneFraction: 0.66, to: assetsDir.appendingPathComponent(name))
}
