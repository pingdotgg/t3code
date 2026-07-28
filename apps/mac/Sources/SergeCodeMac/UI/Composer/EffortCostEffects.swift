import SwiftUI

/// A bounded, popover-local cost warning. The particle and stripe count rises
/// with token risk; the view does not exist for Low–High and its timeline
/// pauses completely when Reduce Motion is enabled.
struct EffortCostBackdrop: View {
    let tier: EffortCostTier
    let color: Color

    var body: some View {
        if tier == .standard {
            EmptyView()
        } else if Motion.reduceMotion {
            effect(phase: 0.25)
        } else {
            TimelineView(
                .animation(minimumInterval: tier.animationFrameInterval)
            ) { timeline in
                effect(phase: timeline.date.timeIntervalSinceReferenceDate)
            }
        }
    }

    private func effect(phase: Double) -> some View {
        let pulseRate: Double =
            switch tier {
            case .standard: 0
            case .extraHigh: 0.8
            case .maximum: 1.4
            case .unlimited: 2.4
            }
        let pulse = (sin(phase * .pi * 2 * pulseRate) + 1) / 2

        return ZStack {
            color.opacity(0.035 + pulse * (tier == .unlimited ? 0.10 : 0.055))

            Canvas { context, size in
                drawParticles(in: &context, size: size, phase: phase)
                if tier >= .maximum {
                    drawHazardStripes(in: &context, size: size, phase: phase)
                }
            }

            RoundedRectangle(cornerRadius: AlpineTheme.Corners.card, style: .continuous)
                .strokeBorder(
                    AngularGradient(
                        colors: borderColors,
                        center: .center,
                        angle: .degrees(phase * borderRotationSpeed)),
                    lineWidth: tier == .unlimited ? 2.5 : 1.5
                )
                .opacity(0.25 + pulse * (tier == .unlimited ? 0.75 : 0.40))
        }
        .clipShape(
            RoundedRectangle(cornerRadius: AlpineTheme.Corners.card, style: .continuous)
        )
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var borderColors: [Color] {
        switch tier {
        case .standard, .extraHigh:
            [color.opacity(0.1), color, color.opacity(0.1)]
        case .maximum:
            [.clear, color, .yellow, color, .clear]
        case .unlimited:
            [.red, .yellow, .red, .clear, .red, .yellow, .red]
        }
    }

    private var borderRotationSpeed: Double {
        switch tier {
        case .standard: 0
        case .extraHigh: 12
        case .maximum: 42
        case .unlimited: 120
        }
    }

    private func drawParticles(
        in context: inout GraphicsContext,
        size: CGSize,
        phase: Double
    ) {
        guard tier.particleCount > 0 else { return }
        let speed = 0.10 + Double(tier.rawValue) * 0.08

        for index in 0..<tier.particleCount {
            let seed = Double(index) / Double(tier.particleCount)
            let travel = (phase * speed + seed).truncatingRemainder(dividingBy: 1)
            let x = size.width * travel
            let wave = sin((travel * 2 + seed * 5) * .pi)
            let y = size.height * (0.18 + seed * 0.64) + wave * 5
            let diameter = 1.5 + Double(index % 3)
            let rect = CGRect(
                x: x - diameter / 2,
                y: y - diameter / 2,
                width: diameter,
                height: diameter)
            context.fill(
                Path(ellipseIn: rect),
                with: .color(color.opacity(tier == .unlimited ? 0.75 : 0.48)))
        }
    }

    private func drawHazardStripes(
        in context: inout GraphicsContext,
        size: CGSize,
        phase: Double
    ) {
        let spacing = tier == .unlimited ? 14.0 : 22.0
        let offset = (phase * (tier == .unlimited ? 44 : 20))
            .truncatingRemainder(dividingBy: spacing)
        var path = Path()
        var x = -size.height + offset
        while x < size.width + size.height {
            path.move(to: CGPoint(x: x, y: size.height))
            path.addLine(to: CGPoint(x: x + size.height, y: 0))
            x += spacing
        }
        context.stroke(
            path,
            with: .color(color.opacity(tier == .unlimited ? 0.18 : 0.09)),
            lineWidth: tier == .unlimited ? 5 : 3)
    }
}

/// Compact language plus motion for the summary's right edge. The label is
/// intentionally blunt: the animation attracts attention, while the words
/// explain why.
struct EffortCostBadge: View {
    let tier: EffortCostTier
    let color: Color

    var body: some View {
        if let label = tier.badgeLabel {
            if Motion.reduceMotion {
                badge(label: label, phase: 0)
            } else {
                TimelineView(
                    .animation(minimumInterval: tier.animationFrameInterval)
                ) { timeline in
                    badge(
                        label: label,
                        phase: timeline.date.timeIntervalSinceReferenceDate)
                }
            }
        }
    }

    private func badge(label: String, phase: Double) -> some View {
        let speed = 0.75 + Double(tier.rawValue) * 0.55
        let beat = sin(phase * .pi * 2 * speed)
        let scale = 1 + max(0, beat) * (tier == .unlimited ? 0.10 : 0.04)
        let shake = tier == .unlimited ? sin(phase * .pi * 9) * 2.2 : 0

        return HStack(spacing: 4) {
            Image(systemName: tier == .extraHigh ? "flame.fill" : "exclamationmark.triangle.fill")
            Text(label)
        }
        .font(.system(size: 9, weight: .black, design: .rounded))
        .foregroundStyle(tier == .unlimited ? Color.white : AlpineTheme.forest)
        .padding(.horizontal, 7)
        .padding(.vertical, 5)
        .background(
            color.opacity(tier == .unlimited ? 0.95 : 0.82),
            in: Capsule())
        .overlay {
            Capsule()
                .stroke(.white.opacity(tier == .unlimited ? 0.65 : 0.30), lineWidth: 1)
        }
        .shadow(
            color: color.opacity(tier == .unlimited ? 0.85 : 0.50),
            radius: tier == .unlimited ? 8 : 4)
        .scaleEffect(scale)
        .rotationEffect(.degrees(shake))
        .accessibilityLabel(label)
    }
}
