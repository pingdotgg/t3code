import SwiftUI

struct SettingsSwipeActionsView: View {
    @Binding var settings: FeatureSwipeSettings
    @State private var direction = SwipePreviewDirection.left

    private var configuration: Binding<FeatureSwipeConfiguration> {
        direction == .left ? $settings.left : $settings.right
    }

    var body: some View {
        Form {
            Section {
                Picker("Swipe direction", selection: $direction) {
                    Text("Swipe Left").tag(SwipePreviewDirection.left)
                    Text("Swipe Right").tag(SwipePreviewDirection.right)
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("swipe-direction")
                SwipeThreadPreview(direction: direction, configuration: configuration.wrappedValue)
                    .id(direction)
                    .listRowInsets(EdgeInsets(top: 12, leading: 0, bottom: 12, trailing: 0))
            } footer: {
                Text("Try swiping the example thread. Your threads won’t change.")
            }
            .listRowBackground(T3Colors.surface)

            Section {
                ForEach(FeatureSwipeAction.allCases, id: \.self) { action in
                    Toggle(isOn: Binding(
                        get: { configuration.wrappedValue.actions.contains(action) },
                        set: { enabled in
                            var updated = configuration.wrappedValue
                            updated.setEnabled(action, enabled: enabled)
                            configuration.wrappedValue = updated
                        }
                    )) {
                        Label {
                            Text(action.settingsTitle)
                        } icon: {
                            Image(systemName: action.example.systemImage)
                                .foregroundStyle(action.color)
                        }
                    }
                    .tint(T3Colors.accent)
                    .accessibilityIdentifier("swipe-action-\(action.rawValue)")
                }
            } header: {
                Text("Buttons when you swipe \(direction.rawValue)")
            } footer: {
                Text("Actions adapt to each thread. Unavailable actions are hidden.")
            }
            .listRowBackground(T3Colors.surface)

            Section {
                Picker("Full swipe", selection: Binding(
                    get: { configuration.wrappedValue.enabledFullSwipe },
                    set: { configuration.wrappedValue.fullSwipe = $0 }
                )) {
                    Text("None").tag(FeatureSwipeAction?.none)
                    ForEach(configuration.wrappedValue.orderedActions, id: \.self) { action in
                        Text(action.settingsTitle).tag(Optional(action))
                    }
                }
                .accessibilityIdentifier("swipe-full-action")
            } footer: {
                Text(configuration.wrappedValue.fullSwipe == .delete
                    ? "A full swipe asks you to confirm deletion."
                    : "The full-swipe action appears at the outside edge. If it’s unavailable, a full swipe does nothing.")
            }
            .listRowBackground(T3Colors.surface)

            Section {
                Button("Reset Both Directions") { settings = .init() }
                    .disabled(settings == FeatureSwipeSettings())
                    .accessibilityIdentifier("swipe-reset")
            }
            .listRowBackground(T3Colors.surface)
        }
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
        .navigationTitle("Swipe Actions")
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
    }
}

private enum SwipePreviewDirection: String {
    case left, right

    var sign: CGFloat { self == .left ? -1 : 1 }
}

/// Uses the Home row itself, with a local gesture that demonstrates the saved
/// choices without sending any thread commands.
private struct SwipeThreadPreview: View {
    @SwiftUI.Environment(\.layoutDirection) private var layoutDirection
    @SwiftUI.Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var rowHeight = 120
    let direction: SwipePreviewDirection
    let configuration: FeatureSwipeConfiguration
    @State private var distance: CGFloat? = 0
    @State private var result: String?
    @State private var dragOrigin: CGFloat?

    private let exampleDate = Date(timeIntervalSince1970: 1_800_000_000)

    private var actions: [FeatureSwipeAction] { configuration.orderedActions }

    var body: some View {
        VStack(spacing: 12) {
            Label("Try swiping \(direction.rawValue)", systemImage: direction == .left ? "arrow.left" : "arrow.right")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(T3Colors.textSecondary)
            GeometryReader { geometry in
                let width = geometry.size.width
                let reveal = min(width * 0.7, CGFloat(actions.count) * 76)
                let offset = min(configuration.enabledFullSwipe == nil ? reveal : width, max(0, distance ?? reveal))
                let full = configuration.enabledFullSwipe != nil && offset > width * 0.8
                ZStack(alignment: direction == .left ? .trailing : .leading) {
                    HStack(spacing: 0) {
                        ForEach(visibleActions(full: full), id: \.self) { action in
                            VStack(spacing: 8) {
                                Image(systemName: action.example.systemImage)
                                    .font(.title3.weight(.semibold))
                                Text(action.example.title)
                                    .font(.caption.weight(.semibold))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.75)
                            }
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(action.color)
                        }
                    }
                    .frame(width: full ? width : max(reveal, offset))

                    FeatureThreadRow(
                        thread: FeatureThread(
                            id: "swipe-example", projectID: "example", title: "Polish the thread list",
                            preview: "Ready for your review", createdAt: exampleDate,
                            updatedAt: exampleDate, lastActivityAt: exampleDate
                        ),
                        context: .fallback,
                        now: exampleDate
                    )
                    .environment(\.layoutDirection, layoutDirection)
                    .padding(.horizontal, 16)
                    .frame(width: width, height: geometry.size.height)
                    .background(T3Colors.surface)
                    .offset(x: direction.sign * offset)
                }
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(T3Colors.border))
                .contentShape(Rectangle())
                .simultaneousGesture(
                    DragGesture(minimumDistance: 15)
                        .onChanged { value in
                            guard !actions.isEmpty, abs(value.translation.width) > abs(value.translation.height) else { return }
                            result = nil
                            if dragOrigin == nil { dragOrigin = distance ?? reveal }
                            distance = (dragOrigin ?? 0) + value.translation.width * direction.sign
                        }
                        .onEnded { value in
                            guard let origin = dragOrigin else { return }
                            let finalDistance = max(0, origin + value.translation.width * direction.sign)
                            let completesFullSwipe = configuration.enabledFullSwipe != nil && finalDistance > width * 0.8
                            if completesFullSwipe, let action = configuration.enabledFullSwipe {
                                result = fullSwipeResult(action)
                            }
                            dragOrigin = nil
                            withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) {
                                distance = completesFullSwipe || finalDistance < reveal * 0.4 ? 0 : nil
                            }
                        }
                )
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Example thread, swipe \(direction.rawValue)")
                .accessibilityValue(actions.isEmpty ? "No swipe actions" : actions.map { $0.example.title }.joined(separator: ", "))
                .accessibilityAction(named: "Try full swipe") {
                    result = configuration.enabledFullSwipe.map(fullSwipeResult) ?? "Full swipe is off"
                }
            }
            .frame(height: rowHeight)
            .environment(\.layoutDirection, .leftToRight)
            .padding(.horizontal, 12)

            Text(result ?? (actions.isEmpty ? "No buttons selected" : distance == 0 ? "Drag the thread to try it" : configuration.enabledFullSwipe == nil ? "Full swipe is off" : "Slide further to try a full swipe"))
                .font(.footnote)
                .foregroundStyle(T3Colors.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 12)
                .accessibilityIdentifier("swipe-preview-result")

            Button(distance == 0 ? "Show buttons" : "Reset example") {
                result = nil
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) {
                    distance = distance == 0 ? nil : 0
                }
            }
            .font(.footnote.weight(.semibold))
            .disabled(actions.isEmpty)
            .accessibilityIdentifier("swipe-preview-toggle")
        }
        .onChange(of: configuration) { _, _ in
            distance = nil
            result = nil
        }
    }

    private func fullSwipeResult(_ action: FeatureSwipeAction) -> String {
        action == .delete ? "Full swipe → Confirm delete" : "Full swipe → \(action.example.title)"
    }

    private func visibleActions(full: Bool) -> [FeatureSwipeAction] {
        if full, let action = configuration.enabledFullSwipe { return [action] }
        return direction == .left ? actions.reversed() : actions
    }
}

private extension FeatureSwipeAction {
    var settingsTitle: String {
        switch self {
        case .settle: "Settle / Reopen"
        case .pin: "Pin / Unpin"
        case .archive: "Archive / Restore"
        case .delete: "Delete"
        }
    }

    var example: HomeThreadSwipeAction {
        switch self {
        case .settle: .settle
        case .pin: .pin
        case .archive: .archive
        case .delete: .delete
        }
    }

    var color: Color { Color(uiColor: example.backgroundColor ?? .systemRed) }
}
