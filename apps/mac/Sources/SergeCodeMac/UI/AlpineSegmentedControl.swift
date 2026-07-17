import SwiftUI

/// App-styled segmented control: quaternary track, sliding secondary thumb,
/// equal-width plain segment buttons. Used on content surfaces (inspector,
/// diff chrome) where glass is forbidden.
struct AlpineSegmentedControl<Value: Hashable>: View {
    struct Segment: Identifiable {
        let value: Value
        let title: String
        var id: Value { value }
    }

    let segments: [Segment]
    @Binding var selection: Value
    var height: CGFloat = 26

    @Namespace private var thumbNamespace
    @UIState private var hovered: Value?

    var body: some View {
        HStack(spacing: 0) {
            ForEach(segments) { segment in
                segmentButton(segment)
            }
        }
        .padding(2)
        .frame(height: height)
        .background {
            RoundedRectangle(
                cornerRadius: AlpineTheme.Corners.control, style: .continuous
            )
            .fill(.quaternary)
        }
        .focusable(true)
        .onMoveCommand(perform: handleMove)
        .animation(Motion.feedback, value: hovered)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func segmentButton(_ segment: Segment) -> some View {
        let isSelected = selection == segment.value
        let isHovering = hovered == segment.value

        Button {
            guard !isSelected else { return }
            withAnimation(Motion.reveal) {
                selection = segment.value
            }
        } label: {
            Text(segment.title)
                .font(.caption.weight(.medium))
                .foregroundStyle(isSelected ? Color.primary : Color.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
                .background {
                    thumbBackground(isSelected: isSelected, isHovering: isHovering)
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

    @ViewBuilder
    private func thumbBackground(isSelected: Bool, isHovering: Bool) -> some View {
        let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
        if isSelected {
            if Motion.reduceMotion {
                // Fade swap only — nothing slides under Reduce Motion.
                shape.fill(.fill.secondary)
                    .transition(.opacity)
            } else {
                shape
                    .fill(.fill.secondary)
                    .matchedGeometryEffect(id: "thumb", in: thumbNamespace)
            }
        } else if isHovering {
            shape.fill(.fill.tertiary)
        }
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
        withAnimation(Motion.reveal) {
            selection = segments[next].value
        }
    }
}

extension AlpineSegmentedControl {
    /// Convenience for string-raw `CaseIterable` enums (e.g. Files | Activity).
    init(
        selection: Binding<Value>,
        height: CGFloat = 26
    ) where Value: CaseIterable & RawRepresentable, Value.RawValue == String, Value.AllCases: RandomAccessCollection {
        self.segments = Value.allCases.map { Segment(value: $0, title: $0.rawValue) }
        self._selection = selection
        self.height = height
    }
}
