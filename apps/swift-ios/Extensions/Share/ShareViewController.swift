import SwiftUI
import UIKit

final class T3ShareViewController: UIViewController {
    private var hostingController: UIHostingController<T3ShareExtensionView>?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let content = T3ShareExtensionView(
            recentThreads: T3SharedRecentThreadStore.shared.records(),
            appearance: T3SharedAppearanceStore.shared.appearance(),
            save: { [weak self] destination in
                let inputItems = self?.extensionContext?.inputItems ?? []
                let payload = await T3SharePayloadLoader.load(from: inputItems)
                return try await Task.detached {
                    try T3IncomingShareStore.write(
                        textFragments: payload.textFragments,
                        images: payload.images,
                        videos: payload.videos,
                        destination: destination,
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
        case saved(message: String)
        case failed(message: String)
    }

    let recentThreads: [T3SharedRecentThreadRecord]
    let appearance: T3SharedAppearance
    let save: (T3IncomingShareDestination) async throws -> T3IncomingShareEnvelope
    let cancel: () -> Void
    let complete: () -> Void

    @State private var phase = Phase.ready
    @State private var searchText = ""

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .ready:
                    destinationList
                case .saving:
                    statusView(
                        symbol: "arrow.down.doc",
                        tint: Color(uiColor: .label),
                        title: "Preparing your share",
                        message: "Keeping a durable copy before opening T3 Code.",
                        showsProgress: true
                    )
                case let .saved(message):
                    statusView(
                        symbol: "checkmark.circle.fill",
                        tint: Color(uiColor: .systemGreen),
                        title: "Ready in T3 Code",
                        message: message,
                        showsProgress: false
                    )
                case let .failed(message):
                    statusView(
                        symbol: "exclamationmark.triangle.fill",
                        tint: Color(uiColor: .systemRed),
                        title: "Could not add this",
                        message: message,
                        showsProgress: false
                    )
                }
            }
            .navigationTitle("Share to T3 Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isSaved ? "Done" : "Cancel") {
                        if isSaved {
                            complete()
                        } else {
                            cancel()
                        }
                    }
                    .disabled(isSaving)
                }
            }
        }
        .preferredColorScheme(preferredColorScheme)
        .background(T3ShareTheme.background.ignoresSafeArea())
    }

    private var isSaving: Bool {
        phase == .saving
    }

    private var isSaved: Bool {
        if case .saved = phase { return true }
        return false
    }

    private var destinationList: some View {
        List {
            Section {
                destinationButton(
                    title: "New Thread",
                    subtitle: "Choose the project in T3 Code",
                    systemImage: "square.and.pencil"
                ) {
                    beginShare(to: .newThread)
                }
            }

            if !recentThreads.isEmpty {
                Section(searchText.isEmpty ? "Recent Threads" : "Threads") {
                    ForEach(filteredThreads) { thread in
                        destinationButton(
                            title: thread.title,
                            subtitle: thread.environmentName,
                            systemImage: "bubble.left.and.bubble.right"
                        ) {
                            beginShare(
                                to: .existingThread(
                                    environmentID: thread.environmentID,
                                    threadID: thread.wireID
                                )
                            )
                        }
                    }
                }
            } else {
                Section("Existing Thread") {
                    Text("Open T3 Code once to make recent threads available here.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                Text("Text and images are staged as-is. A shared video becomes one contact-sheet image so the agent can inspect representative frames.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .scrollContentBackground(.hidden)
        .background(T3ShareTheme.background)
        .searchable(
            text: $searchText,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Find a thread"
        )
    }

    private var filteredThreads: [T3SharedRecentThreadRecord] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return recentThreads }
        return recentThreads.filter {
            $0.title.localizedCaseInsensitiveContains(query)
                || ($0.environmentName?.localizedCaseInsensitiveContains(query) ?? false)
        }
    }

    private func destinationButton(
        title: String,
        subtitle: String?,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: systemImage)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func statusView(
        symbol: String,
        tint: Color,
        title: String,
        message: String,
        showsProgress: Bool
    ) -> some View {
        VStack(spacing: 14) {
            if showsProgress {
                ProgressView()
                    .controlSize(.large)
            } else {
                Image(systemName: symbol)
                    .font(.system(size: 34, weight: .medium))
                    .foregroundStyle(tint)
            }
            Text(title)
                .font(.title2.bold())
            Text(message)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
            if case .failed = phase {
                Button("Choose another destination") {
                    phase = .ready
                }
                .buttonStyle(.borderedProminent)
                .padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(28)
    }

    private func beginShare(to destination: T3IncomingShareDestination) {
        guard phase == .ready else { return }
        phase = .saving
        Task {
            do {
                _ = try await save(destination)
                phase = .saved(message: completionMessage(for: destination))
            } catch {
                phase = .failed(
                    message: (error as? LocalizedError)?.errorDescription
                        ?? "The shared content could not be saved."
                )
            }
        }
    }

    private var preferredColorScheme: ColorScheme? {
        switch appearance {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    private func completionMessage(for destination: T3IncomingShareDestination) -> String {
        switch destination.kind {
        case .newThread:
            "Tap Done, then open T3 Code. The project picker will open with your content in the composer."
        case .existingThread:
            "Tap Done, then open T3 Code. Your content will be waiting in that thread’s composer."
        }
    }
}

private enum T3ShareTheme {
    static let background = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 10 / 255, green: 10 / 255, blue: 10 / 255, alpha: 1)
                : UIColor(red: 242 / 255, green: 242 / 255, blue: 247 / 255, alpha: 1)
        }
    )
}
