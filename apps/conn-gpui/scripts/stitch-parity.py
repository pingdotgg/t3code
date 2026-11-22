#!/usr/bin/env python3
"""Stitches side-by-side `Conn.app | Conn GPUI.app` parity comparison PNGs.

Uses macOS AppKit via `/usr/bin/swift` so zero third-party Python imaging
packages are required on the host or inside `nick-vm`.

Usage:
  python3 scripts/stitch-parity.py <left_conn.png> <right_gpui.png> <out.png> [title]
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SWIFT_STITCH = r"""
import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count >= 4 else {
    fputs("usage: stitch <left.png> <right.png> <out.png> [title]\n", stderr)
    exit(2)
}
let leftURL = URL(fileURLWithPath: args[1])
let rightURL = URL(fileURLWithPath: args[2])
let outURL = URL(fileURLWithPath: args[3])
let title = args.count >= 5 ? args[4] : "Side-by-side parity"

guard let left = NSImage(contentsOf: leftURL), let right = NSImage(contentsOf: rightURL) else {
    fputs("failed to load input images\n", stderr)
    exit(1)
}
guard let leftRep = left.representations.first, let rightRep = right.representations.first else {
    fputs("missing bitmap representations\n", stderr)
    exit(1)
}

let lw = CGFloat(leftRep.pixelsWide)
let lh = CGFloat(leftRep.pixelsHigh)
let rw = CGFloat(rightRep.pixelsWide)
let rh = CGFloat(rightRep.pixelsHigh)
let gap: CGFloat = 24
let headerH: CGFloat = 56
let pad: CGFloat = 20
let totalW = Int(pad * 2 + lw + gap + rw)
let totalH = Int(pad * 2 + headerH + max(lh, rh))

guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: totalW,
    pixelsHigh: totalH,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
) else {
    fputs("failed to allocate output bitmap\n", stderr)
    exit(1)
}

NSGraphicsContext.saveGraphicsState()
let ctx = NSGraphicsContext(bitmapImageRep: rep)!
NSGraphicsContext.current = ctx
NSColor(calibratedWhite: 0.10, alpha: 1.0).setFill()
NSRect(x: 0, y: 0, width: totalW, height: totalH).fill()

let labelAttrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 22, weight: .semibold),
    .foregroundColor: NSColor(calibratedWhite: 0.92, alpha: 1.0),
]
let subAttrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 16, weight: .regular),
    .foregroundColor: NSColor(calibratedWhite: 0.65, alpha: 1.0),
]

let topY = CGFloat(totalH) - pad - 34
NSAttributedString(string: "Conn.app (origin/main) — \(title)", attributes: labelAttrs)
    .draw(at: NSPoint(x: pad, y: topY))
NSAttributedString(string: "Conn GPUI — \(title)", attributes: labelAttrs)
    .draw(at: NSPoint(x: pad + lw + gap, y: topY))
NSAttributedString(string: "\(Int(lw))x\(Int(lh)) vs \(Int(rw))x\(Int(rh))", attributes: subAttrs)
    .draw(at: NSPoint(x: pad, y: topY - 22))

let imgY = pad
left.draw(in: NSRect(x: pad, y: imgY + (max(lh, rh) - lh), width: lw, height: lh))
right.draw(in: NSRect(x: pad + lw + gap, y: imgY + (max(lh, rh) - rh), width: rw, height: rh))
NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else {
    fputs("failed to encode png\n", stderr)
    exit(1)
}
try FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(), withIntermediateDirectories: true)
try png.write(to: outURL)
print(outURL.path)
"""


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: stitch-parity.py <left_conn.png> <right_gpui.png> <out.png> [title]", file=sys.stderr)
        return 2
    args = [str(Path(sys.argv[1]).resolve()), str(Path(sys.argv[2]).resolve()), str(Path(sys.argv[3]).resolve())]
    if len(sys.argv) >= 5:
        args.append(sys.argv[4])
    res = subprocess.run(["/usr/bin/swift", "-", *args], input=SWIFT_STITCH, text=True)
    return res.returncode


if __name__ == "__main__":
    raise SystemExit(main())
