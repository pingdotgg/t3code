import SwiftUI

/// App-styled segmented control: quaternary track, sliding secondary thumb,
/// equal-width plain segment buttons. Used on content surfaces (inspector,
/// diff chrome) where glass is forbidden.
///
/// Thumb position is driven by a GeometryReader + offset (not per-segment
/// `matchedGeometryEffect`) so external binding writes — e.g. UIProbe
/// section toggles — always land on the correct segment. Under Reduce
/// Motion the thumb snaps with an opacity cross-fade instead of sliding.
struct AlpineSegmentedControl<Value: Hashable>: View {
    struct Segment: Identifiable {
        let value: Value
        let title: String
        var id: Value { value }
    }

    let segments: [Segment]
    @Binding var selection: Value
    var height: CGFloat = 26

    @UIState private var hovered: Value?

    var body: some View {
        GeometryReader { geo in
            let count = max(segments.count, 1)
            let pad: CGFloat = 2
            let thumbW = (geo.size.width - pad * 2) / CGFloat(count)
            let thumbH = geo.size.height - pad * 2
            let index = CGFloat(segments.firstIndex(where: { $0.value == selection }) ?? 0)

            ZStack(alignment: .topLeading) {
                RoundedRectangle(
                    cornerRadius: AlpineTheme.Corners.control, style: .continuous
                )
                .fill(.fill.quaternary)

                thumb(
                    width: thumbW,
                    height: thumbH,
                    x: pad + index * thumbW,
                    y: pad
                )

                HStack(spacing: 0) {
                    ForEach(segments) { segment in
                        segmentLabel(segment)
                            .frame(width: thumbW, height: thumbH)
                    }
                }
                .padding(pad)
            }
        }
        .frame(height: height)
        .animation(Motion.reduceMotion ? nil : Motion.reveal, value: selection)
        .animation(Motion.feedback, value: hovered)
        .focusable(true)
        .onMoveCommand(perform: handleMove)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func thumb(width: CGFloat, height: CGFloat, x: CGFloat, y: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(.fill.secondary)
            .frame(width: width, height: height)
            .offset(x: x, y: y)

        if Motion.reduceMotion {
            shape
                .transition(.opacity)
                .id(selection)
        } else {
            shape
        }
    }

    private func segmentLabel(_ segment: Segment) -> some View {
        let isSelected = selection == segment.value
        let isHovering = hovered == segment.value && !isSelected

        return Button {
            guard !isSelected else { return }
            selection = segment.value
        } label: {
            Text(segment.title)
                .font(.caption.weight(.medium))
                .foregroundStyle(isSelected ? Color.primary : Color.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
                .background {
                    if isHovering {
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(.fill.tertiary)
                    }
                }
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            if hovering {
                hovered = segment.value
            } else if hovered == segment.value {
                hovered = nil
            }
        }
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
        .accessibilityLabel(segment.title)
    }

    private func handleMove(_ direction: MoveCommandDirection) {
        guard let index = segments.firstIndex(where: { $0.value == selection }) else {
            return
        }
        let next: Int?
        switch direction {
        case .left:
            next = index > 0 ? index - 1 : nil
        case .right:
            next = index < segments.count - 1 ? index + 1 : nil
        default:
            next = nil
        }
        guard let next else { return }
        selection = segments[next].value
    }
}

extension AlpineSegmentedControl {
    /// Convenience for string-raw `CaseIterable` enums (e.g. Files | Activity).
    init(
        selection: Binding<Value>,
        height: CGFloat = 26
    ) where Value: CaseIterable & RawRepresentable, Value.RawValue == String,
        Value.AllCases: RandomAccessCollection
    {
        self.segments = Value.allCases.map { Segment(value: $0, title: $0.rawValue) }
        self._selection = selection
        self.height = height
    }
}
