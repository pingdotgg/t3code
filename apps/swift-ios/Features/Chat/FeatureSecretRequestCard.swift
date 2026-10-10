import SwiftUI

@MainActor
public protocol FeatureSecretRequestAnswering: AnyObject {
    func answerSecretRequest(threadID: String, source: OrchestrationV2TimelineMetadata, answer: SecretRequestAnswer) async throws
}

@MainActor
struct FeatureSecretRequestContext {
    let threadID: String
    let client: any FeatureSecretRequestAnswering
    var canAnswer: Bool? = true
}

enum FeatureSecretRequestDisplay: Equatable {
    case pending
    case outcome(String)

    static func display(_ item: FeatureV2WorkItem) -> Self {
        switch item.raw["secretStatus"]?.stringValue {
        case "pending": item.source.visibility == "local" ? .pending : .outcome("Waiting for an answer in the original thread")
        case "saved": .outcome("Saved securely and kept private")
        case "declined": .outcome("Declined")
        default: .outcome("Request ended")
        }
    }
}

/// View-owned state only. The synchronous guard closes the gap between two button taps.
@MainActor
final class FeatureSecretRequestController: ObservableObject {
    @Published var value = ""
    @Published private(set) var isSending = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var submitted = false
    private var generation = 0

    @discardableResult
    func submit(_ answer: SecretRequestAnswer, item: FeatureV2WorkItem, context: FeatureSecretRequestContext) -> Task<Void, Never>? {
        updatePermission(context.canAnswer)
        guard context.canAnswer == true, !isSending, !submitted, FeatureSecretRequestDisplay.display(item) == .pending,
              answer.payload != nil else { return nil }
        isSending = true
        errorMessage = nil
        let current = generation
        return Task { @MainActor [weak self] in
            do {
                try await context.client.answerSecretRequest(threadID: context.threadID, source: item.source, answer: answer)
                guard let self, generation == current else { return }
                value = ""
                submitted = true
                isSending = false
            } catch {
                guard let self, generation == current else { return }
                errorMessage = SecretRequestFailure.message(error)
                isSending = false
            }
        }
    }

    func updatePermission(_ canAnswer: Bool?) {
        if canAnswer != true { clear() }
    }

    func clear() {
        generation += 1
        value = ""
        errorMessage = nil
        isSending = false
        submitted = false
    }
}

struct FeatureSecretRequestCard: View {
    let item: FeatureV2WorkItem
    let context: FeatureSecretRequestContext?
    @StateObject private var controller = FeatureSecretRequestController()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(item.raw["label"]?.stringValue ?? "Private secret", systemImage: "lock")
                .font(T3Typography.tool.weight(.medium))
            if let reason = item.raw["reason"]?.stringValue, !reason.isEmpty { Text(reason) }
            switch FeatureSecretRequestDisplay.display(item) {
            case .pending:
                if controller.submitted {
                    Text("Answer sent")
                } else if context?.canAnswer == false {
                    Text("You do not have permission to answer this request.")
                } else if let context, context.canAnswer == true {
                    SecureField(item.raw["placeholder"]?.stringValue ?? "Paste the secret", text: $controller.value)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(controller.isSending)
                        .privacySensitive()
                    Text("Stored securely, never shown to the agent")
                        .foregroundStyle(T3Colors.textSecondary)
                    HStack(spacing: 20) {
                        Button("Save securely") {
                            controller.submit(.save(controller.value), item: item, context: context)
                        }
                        .disabled(controller.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || controller.isSending)
                        Button("Decline") { controller.submit(.decline, item: item, context: context) }
                            .disabled(controller.isSending)
                    }
                    .buttonStyle(.plain)
                    .frame(minHeight: T3Metrics.minimumTapTarget)
                    if let error = controller.errorMessage { Text(error).foregroundStyle(T3Colors.danger) }
                } else {
                    Text("Connect to answer this request.")
                }
            case let .outcome(label): Text(label).foregroundStyle(T3Colors.textSecondary)
            }
        }
        .font(T3Typography.supporting)
        .foregroundStyle(T3Colors.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: item.raw["secretStatus"]) { _, _ in controller.clear() }
        .onChange(of: context?.canAnswer) { _, canAnswer in controller.updatePermission(canAnswer) }
        .onDisappear { controller.clear() }
    }
}
