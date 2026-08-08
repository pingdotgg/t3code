import SwiftUI

struct FeatureComposerCommandPopover: View {
    let triggerKind: FeatureComposerTriggerKind
    let items: [FeatureComposerMenuItem]
    let isLoading: Bool
    let errorMessage: String?
    let pathSearchAvailable: Bool
    let onSelect: (FeatureComposerMenuItem) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if items.isEmpty {
                Text(emptyMessage)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                            Button {
                                onSelect(item)
                            } label: {
                                FeatureComposerCommandRow(item: item)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("composer-suggestion-\(item.id)")

                            if index < items.count - 1 {
                                Divider()
                                    .overlay(T3Colors.separator)
                                    .padding(.leading, 40)
                            }
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }
        }
        .frame(height: menuHeight, alignment: .top)
        .background(T3Colors.surfaceRaised.opacity(0.98))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(T3Colors.border, lineWidth: 1)
        }
        .accessibilityLabel(groupLabel)
        .accessibilityIdentifier("composer-command-menu")
    }

    private var groupLabel: String {
        switch triggerKind {
        case .slashCommand: return "Commands"
        case .model: return "Models"
        case .skill: return "Skills"
        case .path: return "Files"
        }
    }

    private var emptyMessage: String {
        if isLoading { return "Searching files…" }
        if let errorMessage, !errorMessage.isEmpty { return errorMessage }
        switch triggerKind {
        case .slashCommand: return "No matching commands."
        case .model: return "No matching models."
        case .skill: return "No matching skills."
        case .path where !pathSearchAvailable: return "File search is unavailable."
        case .path: return "Type a file name to search."
        }
    }

    private var menuHeight: CGFloat {
        guard !items.isEmpty else { return 48 }
        let rowHeight: CGFloat = 47
        return min(CGFloat(items.count) * rowHeight, 188)
    }
}

private struct FeatureComposerCommandRow: View {
    let item: FeatureComposerMenuItem

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: iconName)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(T3Colors.textTertiary)
                .frame(width: 17)

            Text(item.label)
                .font(T3Typography.control)
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(1)

            if !item.description.isEmpty {
                Text(item.description)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 46)
        .contentShape(Rectangle())
    }

    private var iconName: String {
        switch item {
        case .modelCommand, .providerCommand: return "terminal"
        case .model: return "cpu"
        case .skill: return "shippingbox"
        case let .path(entry): return entry.kind == .directory ? "folder" : "doc"
        }
    }
}
