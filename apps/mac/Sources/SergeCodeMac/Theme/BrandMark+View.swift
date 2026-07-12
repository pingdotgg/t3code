import SwiftUI

struct BrandMarkShape: Shape {
    var candidate: BrandMarkCandidate = .passportPeak

    func path(in rect: CGRect) -> Path {
        Path(BrandMarkGeometry.silhouette(candidate, in: rect))
    }
}

struct BrandMarkView: View {
    enum Style: Equatable, Sendable {
        case monochrome
        case fullColor
    }

    let candidate: BrandMarkCandidate
    let style: Style

    init(
        candidate: BrandMarkCandidate = .passportPeak,
        style: Style = .monochrome
    ) {
        self.candidate = candidate
        self.style = style
    }

    var body: some View {
        Group {
            switch style {
            case .monochrome:
                BrandMarkMonochromeShape(candidate: candidate)
                    .fill(style: FillStyle(eoFill: true))
                    .foregroundStyle(.tint)

            case .fullColor:
                ZStack {
                    BrandMarkShape(candidate: candidate)
                        .fill(style: fillStyle)
                        .foregroundStyle(mossColor)

                    if BrandMarkGeometry.accent(candidate, in: .init(x: 0, y: 0, width: 1, height: 1)) != nil {
                        BrandMarkAccentShape(candidate: candidate)
                            .fill(snowColor)
                    }
                }
            }
        }
        .aspectRatio(1, contentMode: .fit)
    }

    private var fillStyle: FillStyle {
        FillStyle(eoFill: usesEvenOddFill)
    }

    private var usesEvenOddFill: Bool {
        switch candidate {
        case .surgePeak:
            return false
        case .notchPeak, .passportPeak:
            return true
        }
    }

    private var mossColor: Color {
        let rgb = BrandMarkGeometry.moss
        return Color(red: Double(rgb.red), green: Double(rgb.green), blue: Double(rgb.blue))
    }

    private var snowColor: Color {
        let rgb = BrandMarkGeometry.snow
        return Color(red: Double(rgb.red), green: Double(rgb.green), blue: Double(rgb.blue))
    }
}

private struct BrandMarkMonochromeShape: Shape {
    let candidate: BrandMarkCandidate

    func path(in rect: CGRect) -> Path {
        let compound = CGMutablePath()
        compound.addPath(BrandMarkGeometry.silhouette(candidate, in: rect))
        if let accent = BrandMarkGeometry.accent(candidate, in: rect) {
            compound.addPath(accent)
        }
        return Path(compound)
    }
}

private struct BrandMarkAccentShape: Shape {
    let candidate: BrandMarkCandidate

    func path(in rect: CGRect) -> Path {
        guard let accent = BrandMarkGeometry.accent(candidate, in: rect) else { return Path() }
        return Path(accent)
    }
}
