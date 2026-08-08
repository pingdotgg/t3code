import SwiftUI
import UIKit

final class T3ShareViewController: UIViewController {
    private var hostingController: UIHostingController<T3ShareExtensionView>?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let content = T3ShareExtensionView(
            save: { [weak self] in
                let inputItems = self?.extensionContext?.inputItems ?? []
                let payload = await T3SharePayloadLoader.load(from: inputItems)
                return try await Task.detached {
                    try T3IncomingShareStore.write(
                        textFragments: payload.textFragments,
                        images: payload.images,
                        warnings: payload.warnings
                    )
                }.value
            },
            cancel: { [weak self] in
                self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
            },
            complete: { [weak self] in
                self?.extensionContext?.completeRequest(returningItems: nil)
            }
        )
        let hostingController = UIHostingController(rootView: content)
        hostingController.view.backgroundColor = .systemBackground
        addChild(hostingController)
        hostingController.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hostingController.view)
        NSLayoutConstraint.activate([
            hostingController.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hostingController.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            hostingController.view.topAnchor.constraint(equalTo: view.topAnchor),
            hostingController.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        hostingController.didMove(toParent: self)
        self.hostingController = hostingController
    }
}

struct T3ShareExtensionView: View {
    enum Phase: Equatable {
        case ready
        case saving
        case saved(imageCount: Int)
        case failed(message: String)
    }

    let save: () async throws -> T3IncomingShareEnvelope
    let cancel: () -> Void
    let complete: () -> Void

    @State private var phase = Phase.ready

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Cancel", action: cancel)
                    .foregroundStyle(.secondary)
                    .disabled(isSaving)
                Spacer()
                Text("T3 Code")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(.primary)
                Spacer()
                Color.clear.frame(width: 52, height: 1)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 15)

            Divider()

            VStack(spacing: 14) {
                Image(systemName: phaseSymbol)
                    .font(.system(size: 32, weight: .medium))
                    .foregroundStyle(phaseTint)
                    .accessibilityHidden(true)
                Text(title)
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.center)
                Text(message)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, 28)
            .padding(.vertical, 24)

            Button(action: primaryAction) {
                Text(primaryTitle)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color(uiColor: .systemBackground))
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .background(Color(uiColor: .label), in: RoundedRectangle(cornerRadius: 13))
            }
            .buttonStyle(.plain)
            .disabled(isSaving)
            .opacity(isSaving ? 0.55 : 1)
            .padding(.horizontal, 18)
            .padding(.bottom, 18)
        }
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
    }

    private var isSaving: Bool {
        phase == .saving
    }

    private var title: String {
        switch phase {
        case .ready: "Add to a new task"
        case .saving: "Saving shared content"
        case .saved: "Ready in T3 Code"
        case .failed: "Could not add this"
        }
    }

    private var message: String {
        switch phase {
        case .ready:
            "Text, links, and up to eight images will be waiting in the native composer."
        case .saving:
            "Keeping a durable copy so nothing gets lost."
        case let .saved(imageCount):
            imageCount == 0
                ? "Open T3 Code to choose a project and send it."
                : "Saved \(imageCount) image\(imageCount == 1 ? "" : "s"). Open T3 Code to choose a project."
        case let .failed(message):
            message
        }
    }

    private var phaseSymbol: String {
        switch phase {
        case .ready: "square.and.arrow.up"
        case .saving: "arrow.down.doc"
        case .saved: "checkmark.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        }
    }

    private var phaseTint: Color {
        switch phase {
        case .saved: Color(uiColor: .systemGreen)
        case .failed: Color(uiColor: .systemRed)
        default: Color(uiColor: .label)
        }
    }

    private var primaryTitle: String {
        switch phase {
        case .ready: "Add to T3 Code"
        case .saving: "Saving…"
        case .saved: "Done"
        case .failed: "Try again"
        }
    }

    private func primaryAction() {
        switch phase {
        case .ready, .failed:
            phase = .saving
            Task {
                do {
                    let envelope = try await save()
                    phase = .saved(imageCount: envelope.images.count)
                } catch {
                    phase = .failed(
                        message: (error as? LocalizedError)?.errorDescription
                            ?? "The shared content could not be saved."
                    )
                }
            }
        case .saved:
            complete()
        case .saving:
            break
        }
    }
}
