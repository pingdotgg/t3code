import SwiftUI

/// The reasoning-effort ramp as a draggable slider rather than a list of rows.
///
/// Effort is an *ordered level*, not a set of alternatives, and a stack of
/// radio rows says nothing about that ordering — the ramp's color, its symbol,
/// and the distance between "minimal" and "max" all have to be read off the
/// labels. The slider makes the ordering the control: one knob travelling a
/// colored track, detents you can feel, and the level's own symbol riding the
/// knob.
///
/// Cost of the fun is bounded. Nothing here animates on its own — every curve
/// is driven by a state change the user caused — and Reduce Motion keeps the
/// travel while dropping the overshoot, the bounce, and the glow.
struct EffortSlider: View {
    /// One detent: a provider effort choice already resolved onto the shared
    /// ramp, so the view never re-derives color or symbol.
    struct Stop: Identifiable, Equatable {
        let id: String
        let label: String
        let isProviderDefault: Bool
        let style: EffortLevelStyle

        var color: Color { AlpineTheme.effortColor(slot: style.slot) }
        var symbolName: String { style.symbolName }
    }

    let stops: [Stop]
    /// The effort currently in force on the thread, as the backend reports it.
    let selectedID: String?
    let onSelect: (String) -> Void

    /// Live pointer position (0...1) while dragging. The knob follows the
    /// finger continuously; the detents are where it lands, not a cage.
    @UIState private var dragProgress: Double?
    /// Detent the pointer is currently claiming, so tint and label lead the
    /// release rather than waiting for the backend round-trip.
    @UIState private var dragIndex: Int?
    /// Choice already sent and not yet echoed back. Without it the knob snaps
    /// home for one frame between the release and the thread update.
    @UIState private var pendingID: String?
    @UIState private var isDragging = false
    @UIState private var isHovering = false
    @FocusState private var isFocused: Bool

    private let trackHeight: CGFloat = 10
    private let knobDiameter: CGFloat = 30
    private let labelHeight: CGFloat = 14
    private let labelGap: CGFloat = 6

    private var selectedIndex: Int {
        let target = pendingID ?? selectedID
        return stops.firstIndex { $0.id == target } ?? 0
    }

    /// The level everything visual reads from: the drag if one is in flight,
    /// otherwise the committed choice.
    private var activeIndex: Int { dragIndex ?? selectedIndex }

    private var activeStop: Stop? {
        stops.indices.contains(activeIndex) ? stops[activeIndex] : stops.first
    }

    private var activeColor: Color { activeStop?.color ?? AlpineTheme.accent }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            summary
            GeometryReader { proxy in
                let geometry = EffortSliderGeometry(
                    stopCount: stops.count,
                    width: Double(proxy.size.width),
                    inset: Double(knobDiameter / 2)
                )
                ZStack(alignment: .topLeading) {
                    track(geometry)
                    tickLabels(geometry)
                }
            }
            .frame(height: knobDiameter + labelGap + labelHeight)
        }
        .padding(12)
        .background {
            RoundedRectangle(cornerRadius: AlpineTheme.Corners.card, style: .continuous)
                .fill(activeColor.opacity(0.10))
                .overlay {
                    RoundedRectangle(cornerRadius: AlpineTheme.Corners.card, style: .continuous)
                        .stroke(activeColor.opacity(isFocused ? 0.85 : 0.28))
                }
                // Scoped to the card's own tint: an animation on the whole
                // slider would also claim the knob's travel and override the
                // spring it lands on.
                .animation(Motion.feedback, value: activeIndex)
                .animation(Motion.feedback, value: isFocused)
        }
        .focusable(true)
        .focused($isFocused)
        .focusEffectDisabled()
        .onMoveCommand(perform: handleMove)
        .onAppear {
            // The ramp is the run-profile popover's primary control, so arrow
            // keys adjust the level as soon as it opens rather than after a Tab.
            isFocused = true
        }
        .onDisappear {
            // A rejected change never echoes back, and a pending id left
            // behind would show a level the thread is not running.
            pendingID = nil
        }
        .onChange(of: selectedID) { _, _ in pendingID = nil }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Reasoning effort")
        .accessibilityValue(accessibilityValue)
        .accessibilityHint("Higher levels let the model think longer before answering")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: move(by: 1)
            case .decrement: move(by: -1)
            @unknown default: break
            }
        }
    }

    private var accessibilityValue: String {
        guard let activeStop else { return "Unavailable" }
        var value = "\(activeStop.label), level \(activeIndex + 1) of \(stops.count)"
        if activeStop.isProviderDefault { value += ", provider default" }
        return value
    }

    // MARK: - Summary

    /// The level in words, above the track: the ramp's own symbol on a tinted
    /// tile, the choice's label, and where it sits on the ramp.
    private var summary: some View {
        HStack(spacing: 10) {
            symbolTile
            VStack(alignment: .leading, spacing: 1) {
                Text(activeStop?.label ?? "—")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.primary)
                    .contentTransition(Motion.reduceMotion ? .identity : .interpolate)
                Text(summaryDetail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            levelPips
        }
        .animation(Motion.feedback, value: activeIndex)
    }

    private var symbolTile: some View {
        let symbol = Image(systemName: activeStop?.symbolName ?? "brain")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(AlpineTheme.forest)
            .frame(width: 30, height: 30)
            .background(
                activeColor.opacity(0.9),
                in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous))

        return Group {
            if Motion.reduceMotion {
                symbol
            } else {
                symbol
                    .contentTransition(.symbolEffect(.replace))
                    .symbolEffect(.bounce, value: activeIndex)
            }
        }
    }

    private var summaryDetail: String {
        guard let activeStop else { return "" }
        if activeStop.isProviderDefault { return "Provider default" }
        return "Level \(activeIndex + 1) of \(stops.count)"
    }

    /// A stack of bars that fills as the level rises — the same information the
    /// track carries, at a glance, for anyone reading the summary alone.
    private var levelPips: some View {
        HStack(spacing: 2) {
            ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
                Capsule()
                    .fill(index <= activeIndex ? stop.color : Color.secondary.opacity(0.22))
                    .frame(width: 3, height: 6 + CGFloat(index) * 3)
            }
        }
        .accessibilityHidden(true)
    }

    // MARK: - Track

    private func track(_ geometry: EffortSliderGeometry) -> some View {
        let progress = dragProgress ?? geometry.progress(of: activeIndex)
        let knobX = CGFloat(geometry.x(atProgress: progress))

        return ZStack(alignment: .leading) {
            Capsule()
                .fill(.fill.quaternary)
                .frame(height: trackHeight)

            Capsule()
                .fill(fillGradient)
                .frame(width: knobX, height: trackHeight)

            detents(geometry)

            knob
                .position(x: knobX, y: knobDiameter / 2)
        }
        .frame(height: knobDiameter)
        .contentShape(Rectangle())
        .gesture(dragGesture(geometry))
        .onHover { isHovering = $0 }
        // While dragging, the knob is the pointer — animating it would make it
        // lag the finger. Everything else about the move still eases.
        .animation(isDragging ? nil : Motion.knob, value: progress)
        .animation(Motion.feedback, value: isDragging)
        .animation(Motion.feedback, value: isHovering)
    }

    /// The ramp painted onto the fill, so the traversed part of the track shows
    /// the levels it passed rather than one flat tint.
    private var fillGradient: LinearGradient {
        var colors = stops.prefix(activeIndex + 1).map(\.color)
        if colors.count < 2 { colors.append(activeColor) }
        return LinearGradient(colors: colors, startPoint: .leading, endPoint: .trailing)
    }

    private func detents(_ geometry: EffortSliderGeometry) -> some View {
        ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
            let isPassed = index <= activeIndex
            Circle()
                .fill(isPassed ? AlpineTheme.forest.opacity(0.35) : stop.color.opacity(0.55))
                .frame(width: 4, height: 4)
                .scaleEffect(index == activeIndex ? 1.6 : 1)
                .position(x: CGFloat(geometry.x(of: index)), y: knobDiameter / 2)
        }
        .allowsHitTesting(false)
        .animation(Motion.feedback, value: activeIndex)
    }

    private var knob: some View {
        let glow: CGFloat =
            Motion.reduceMotion ? 0 : 5 + CGFloat(activeStop?.style.rank ?? 0) * 9

        return ZStack {
            Circle()
                .fill(activeColor.gradient)
            Circle()
                .strokeBorder(.white.opacity(0.55), lineWidth: 1)
            knobSymbol
        }
        .frame(width: knobDiameter, height: knobDiameter)
        .shadow(color: activeColor.opacity(0.55), radius: glow)
        .scaleEffect(isDragging ? 1.14 : (isHovering || isFocused ? 1.06 : 1))
        .allowsHitTesting(false)
    }

    private var knobSymbol: some View {
        let symbol = Image(systemName: activeStop?.symbolName ?? "brain")
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(AlpineTheme.forest)

        return Group {
            if Motion.reduceMotion {
                symbol
            } else {
                symbol
                    .contentTransition(.symbolEffect(.replace))
                    .symbolEffect(.bounce, value: activeIndex)
            }
        }
    }

    private func tickLabels(_ geometry: EffortSliderGeometry) -> some View {
        let cellWidth = max(28, CGFloat(geometry.span) / CGFloat(max(1, stops.count - 1)))

        return ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
            Text(stop.label)
                .font(.caption2.weight(index == activeIndex ? .semibold : .regular))
                .foregroundStyle(index == activeIndex ? Color.primary : Color.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(width: cellWidth)
                .position(
                    x: CGFloat(geometry.labelX(of: index, labelWidth: Double(cellWidth))),
                    y: knobDiameter + labelGap + labelHeight / 2)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .animation(Motion.feedback, value: activeIndex)
    }

    // MARK: - Input

    /// `minimumDistance: 0` so a plain click anywhere on the track jumps to the
    /// nearest detent — the common adjustment is one level over, and hunting
    /// for the knob first would make that a two-step gesture.
    private func dragGesture(_ geometry: EffortSliderGeometry) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                isDragging = true
                dragProgress = geometry.progress(atX: Double(value.location.x))
                let next = geometry.index(atX: Double(value.location.x))
                if let event = EffortSliderGeometry.feedback(
                    from: activeIndex, to: next, stopCount: stops.count)
                {
                    Haptics.play(event)
                }
                dragIndex = next
            }
            .onEnded { value in
                let next = geometry.index(atX: Double(value.location.x))
                isDragging = false
                // The knob keeps the detent it landed on: `dragIndex` clears
                // only once `commit` has recorded the same level as pending.
                dragProgress = nil
                dragIndex = nil
                commit(next)
            }
    }

    private func handleMove(_ direction: MoveCommandDirection) {
        switch direction {
        case .left: move(by: -1)
        case .right: move(by: 1)
        default: break
        }
    }

    private func move(by delta: Int) {
        let next = EffortSliderGeometry.step(
            from: activeIndex, by: delta, stopCount: stops.count)
        guard next != activeIndex else {
            // Arrowing past either end: the ramp refuses, and says so.
            Haptics.play(.boundary)
            return
        }
        Haptics.play(
            EffortSliderGeometry.feedback(from: activeIndex, to: next, stopCount: stops.count)
                ?? .step)
        commit(next)
    }

    private func commit(_ index: Int) {
        guard stops.indices.contains(index) else { return }
        let stop = stops[index]
        guard stop.id != (pendingID ?? selectedID) else { return }
        pendingID = stop.id
        onSelect(stop.id)
    }
}
