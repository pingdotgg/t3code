import CoreGraphics
import Foundation

public enum BrandMarkCandidate: String, CaseIterable, Sendable {
    case surgePeak
    case notchPeak
    case passportPeak
}

/// The shared, normalized geometry for the SurgeCode brand-mark candidates.
///
/// Coordinates use a top-left origin: (0, 0) is the top-left of the mark and
/// (1, 1) is the bottom-right. Every path is fitted into the largest centered
/// square inside the supplied rect, so the same paths can be rendered by
/// SwiftUI and by standalone CoreGraphics tools without distortion.
public enum BrandMarkGeometry {
    public struct RGB: Equatable, Sendable {
        public let red: CGFloat
        public let green: CGFloat
        public let blue: CGFloat

        public init(red: CGFloat, green: CGFloat, blue: CGFloat) {
            self.red = red
            self.green = green
            self.blue = blue
        }

        public func cgColor(alpha: CGFloat = 1) -> CGColor {
            CGColor(
                colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                components: [red, green, blue, alpha])!
        }
    }

    /// Alpine moss, #4C7559.
    public static let moss = RGB(
        red: CGFloat(0x4C) / 255,
        green: CGFloat(0x75) / 255,
        blue: CGFloat(0x59) / 255)
    /// Snow, #F2F7FB.
    public static let snow = RGB(
        red: CGFloat(0xF2) / 255,
        green: CGFloat(0xF7) / 255,
        blue: CGFloat(0xFB) / 255)
    /// Deep spruce, #163325.
    public static let deepSpruce = RGB(
        red: CGFloat(0x16) / 255,
        green: CGFloat(0x33) / 255,
        blue: CGFloat(0x25) / 255)
    /// Sky stops, #2F6BB0 → #8ABCE2 → #F4E7C6.
    public static let skyStops: [RGB] = [
        RGB(red: CGFloat(0x2F) / 255, green: CGFloat(0x6B) / 255, blue: CGFloat(0xB0) / 255),
        RGB(red: CGFloat(0x8A) / 255, green: CGFloat(0xBC) / 255, blue: CGFloat(0xE2) / 255),
        RGB(red: CGFloat(0xF4) / 255, green: CGFloat(0xE7) / 255, blue: CGFloat(0xC6) / 255),
    ]

    /// Primary mark silhouette, scaled to fit `rect`, preserving aspect.
    public static func silhouette(_ candidate: BrandMarkCandidate, in rect: CGRect) -> CGPath {
        let square = fittingSquare(in: rect)
        guard square.width > 0, square.height > 0 else { return CGMutablePath() }

        switch candidate {
        case .surgePeak:
            return polygon([
                (0.06, 1.00),
                (0.32, 0.28),
                (0.50, 0.64),
                (0.68, 0.00),
                (0.95, 1.00),
            ], in: square)

        case .notchPeak:
            let path = CGMutablePath()
            let radius = square.width * 0.22
            path.addRoundedRect(
                in: square,
                cornerWidth: radius,
                cornerHeight: radius,
                transform: .identity)

            // The inner path opens through the bottom of the field. Its left
            // edge makes the stepped S/lightning profile; the right edge is a
            // single clean line back to the apex.
            path.move(to: point(0.50, 0.22, in: square))
            path.addLine(to: point(0.37, 0.52, in: square))
            path.addLine(to: point(0.28, 0.52, in: square))
            path.addLine(to: point(0.18, 1.00, in: square))
            path.addLine(to: point(0.82, 1.00, in: square))
            path.closeSubpath()
            return path

        case .passportPeak:
            let path = CGMutablePath()
            let ringThickness = square.width * 0.082
            path.addEllipse(in: square)
            path.addEllipse(in: square.insetBy(dx: ringThickness, dy: ringThickness))

            // The two peaks share a baseline and remain comfortably inside
            // the inner disc, leaving the ring readable at favicon sizes.
            path.move(to: point(0.20, 0.72, in: square))
            path.addLine(to: point(0.38, 0.48, in: square))
            path.addLine(to: point(0.50, 0.72, in: square))
            path.closeSubpath()

            path.move(to: point(0.50, 0.72, in: square))
            path.addLine(to: point(0.62, 0.32, in: square))
            path.addLine(to: point(0.80, 0.72, in: square))
            path.closeSubpath()
            return path
        }
    }

    /// Secondary/negative-space path for full-color rendering.
    public static func accent(_ candidate: BrandMarkCandidate, in rect: CGRect) -> CGPath? {
        guard candidate == .surgePeak else { return nil }

        let square = fittingSquare(in: rect)
        guard square.width > 0, square.height > 0 else { return nil }

        // A broad, straight-edged snow switchback: down the tall peak's left
        // flank, across the saddle, then down-left onto the short peak.
        return polygon([
            (0.68, 0.02),
            (0.62, 0.03),
            (0.53, 0.54),
            (0.42, 0.54),
            (0.34, 0.64),
            (0.28, 0.50),
            (0.36, 0.43),
            (0.47, 0.61),
            (0.51, 0.61),
            (0.58, 0.20),
        ], in: square)
    }

    private static func fittingSquare(in rect: CGRect) -> CGRect {
        let bounds = rect.standardized
        let side = min(bounds.width, bounds.height)
        guard side > 0 else { return .zero }
        return CGRect(
            x: bounds.midX - side / 2,
            y: bounds.midY - side / 2,
            width: side,
            height: side)
    }

    private static func point(_ x: CGFloat, _ y: CGFloat, in square: CGRect) -> CGPoint {
        CGPoint(
            x: square.minX + square.width * x,
            y: square.minY + square.height * y)
    }

    private static func polygon(
        _ points: [(CGFloat, CGFloat)],
        in square: CGRect
    ) -> CGPath {
        let path = CGMutablePath()
        guard let first = points.first else { return path }
        path.move(to: point(first.0, first.1, in: square))
        for (x, y) in points.dropFirst() {
            path.addLine(to: point(x, y, in: square))
        }
        path.closeSubpath()
        return path
    }
}
