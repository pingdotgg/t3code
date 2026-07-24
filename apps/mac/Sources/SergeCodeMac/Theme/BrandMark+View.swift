import SwiftUI

struct BrandMarkShape: Shape {
    var candidate: BrandMarkCandidate = .passportPeak

    func path(in rect: CGRect) -> Path {
        Path(BrandMarkGeometry.silhouette(candidate, in: rect))
    }
}

@MainActor
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

            // The shipped app-icon look: the snow mark on the sky-gradient
            // squircle, matching scripts/generate-appicon.swift. There is no
            // green variant of the mark; fullColor always renders this one.
            case .fullColor:
                GeometryReader { proxy in
                    let side = min(proxy.size.width, proxy.size.height)
                    ZStack {
                        RoundedRectangle(cornerRadius: side * 0.225, style: .continuous)
                            .fill(
                                LinearGradient(
                                    stops: skyGradientStops,
                                    startPoint: .top,
                                    endPoint: .bottom))
                        BrandMarkShape(candidate: candidate)
                            .fill(style: FillStyle(eoFill: true))
                            .foregroundStyle(snowColor)
                            .frame(width: side * 0.65, height: side * 0.65)
                            .offset(y: -side * 0.016)
                    }
                    .frame(width: proxy.size.width, height: proxy.size.height)
                }
            }
        }
        .aspectRatio(1, contentMode: .fit)
    }

    private var skyGradientStops: [Gradient.Stop] {
        zip(BrandMarkGeometry.skyStops, [0, 0.55, 1]).map { rgb, location in
            Gradient.Stop(
                color: Color(red: Double(rgb.red), green: Double(rgb.green), blue: Double(rgb.blue)),
                location: location)
        }
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
