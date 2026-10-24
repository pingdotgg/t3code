import SwiftUI

/// Keep the last started selection, since queued selections have no context to hand off.
public struct FeatureComposerHandoffSource: Codable, Equatable, Sendable {
    public let hasVisibleTurnItems: Bool
    public let selection: FeatureSelection?

    public init(hasVisibleTurnItems: Bool, selection: FeatureSelection?) {
        self.hasVisibleTurnItems = hasVisibleTurnItems
        self.selection = selection
    }

    public init(projection: JSONValue) {
        // The native control projection keeps assistant rows only; its flag counts every row.
        hasVisibleTurnItems = projection["hasVisibleTurnItems"]?.boolValue
            ?? (projection["visibleTurnItems"]?.v2Array?.isEmpty == false)
        let latest = projection["runs"]?.v2Array?.last {
            $0["startedAt"]?.stringValue != nil && $0["status"]?.stringValue != "rolled_back"
        }
        if let model = latest?["modelSelection"],
           let instanceID = model["instanceId"]?.stringValue,
           let modelID = model["model"]?.stringValue {
            selection = FeatureSelection(providerID: instanceID, modelID: modelID)
        } else {
            selection = nil
        }
    }
}

struct FeatureComposerPendingHandoff: Equatable, Sendable {
    let from: FeatureSelection
    let to: FeatureSelection

    /// Matches client-runtime/handoff.ts, including providers absent from the current catalog.
    static func resolve(
        source: FeatureComposerHandoffSource?,
        selection: FeatureSelection?,
        providers: [FeatureProvider]
    ) -> Self? {
        guard let source, source.hasVisibleTurnItems, let from = source.selection,
              let selection else { return nil }
        let sourceProvider = providers.first { $0.id == from.providerID }
        let targetProvider = providers.first { $0.id == selection.providerID }
        let needsHandoff: Bool
        if from.providerID == selection.providerID {
            needsHandoff = from.modelID != selection.modelID
                && targetProvider?.requiresNewThreadForModelChange == true
        } else {
            needsHandoff = sourceProvider?.continuationGroupKey == nil
                || sourceProvider?.driver != targetProvider?.driver
                || sourceProvider?.continuationGroupKey != targetProvider?.continuationGroupKey
        }
        return needsHandoff ? Self(from: from, to: selection) : nil
    }
}

struct FeatureComposerHandoffPreview: View {
    let source: FeatureComposerHandoffSource?
    let selection: FeatureSelection?
    let providers: [FeatureProvider]

    var body: AnyView {
        guard let handoff = FeatureComposerPendingHandoff.resolve(
            source: source, selection: selection, providers: providers
        ) else { return AnyView(EmptyView()) }
        return AnyView(
            VStack(spacing: 4) {
                Label("Context handoff pending", systemImage: "arrow.left.arrow.right")
                Text("\(label(handoff.from)) → \(label(handoff.to))")
                    .lineLimit(2)
            }
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .accessibilityIdentifier("composer-pending-handoff")
        )
    }

    private func label(_ selection: FeatureSelection) -> String {
        let provider = providers.first { $0.id == selection.providerID }
        return provider?.models.first { $0.id == selection.modelID }?.name ?? selection.modelID
    }
}
