import SwiftUI

private enum TerminalFontSize {
    static let minimum = 6.0
    static let maximum = 32.0
    static let step = 0.5
    static let defaultValue = 10.5

    static func normalized(_ value: Double) -> Double {
        min(maximum, max(minimum, value))
    }
}

enum TerminalSessionList {
    static func initialID(in sessions: [FeatureTerminalSnapshot]) -> String {
        let running = sessions.filter { $0.state == .running || $0.state == .starting }
        return running.first(where: { $0.terminalID == "default" })?.terminalID
            ?? running.first?.terminalID
            ?? "default"
    }

    static func nextID(occupiedIDs: [String]) -> String {
        let occupied = Set(occupiedIDs)
        guard occupied.contains("default") else { return "default" }
        var index = 2
        while occupied.contains("term-\(index)") { index += 1 }
        return "term-\(index)"
    }

    static func fallbackID(
        in sessions: [FeatureTerminalSnapshot],
        excluding terminalID: String
    ) -> String? {
        sessions.first {
            $0.terminalID != terminalID && ($0.state == .running || $0.state == .starting)
        }?.terminalID
    }

    static func displayTitle(for session: FeatureTerminalSnapshot) -> String {
        let number: Int
        if session.terminalID == "default" {
            number = 1
        } else if session.terminalID.hasPrefix("term-"),
                  let parsed = Int(session.terminalID.dropFirst("term-".count)) {
            number = parsed
        } else {
            return session.title
        }

        let shell = session.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !shell.isEmpty, shell.caseInsensitiveCompare("Terminal") != .orderedSame else {
            return "Terminal \(number)"
        }
        return "Terminal \(number) · \(shell)"
    }
}

/// Serializes input for one attached terminal. A session change drops unsent
/// chunks. A new paste also replaces the unsent part of an older paste.
/// Keys waiting for a response share one batch, so typing does not wait once per key.
@MainActor
final class TerminalInputSession {
    struct Target: Equatable, Sendable {
        let threadID: String
        let terminalID: String
        let lifecycleVersion: Int
    }

    private final class KeyBatch {
        var data: String

        init(_ data: String) {
            self.data = data
        }
    }

    private var target: Target?
    private var isAttached = false
    private var generation: UInt64 = 0
    private var latestPasteRequest: UInt64 = 0
    private var writeTail: Task<Bool, Never>?
    private var pendingKeys: KeyBatch?

    func attach(to target: Target?) {
        isAttached = true
        updateTarget(target)
    }

    func updateTarget(_ target: Target?) {
        guard self.target != target else { return }
        self.target = target
        pendingKeys = nil
        generation &+= 1
    }

    func detach() {
        isAttached = false
        pendingKeys = nil
        generation &+= 1
    }

    @discardableResult
    func enqueue(
        _ data: String,
        target: Target,
        isPaste: Bool = false,
        write: @escaping @MainActor (String) async -> Bool
    ) -> Task<Bool, Never>? {
        guard isAttached, self.target == target, !data.isEmpty else { return nil }
        let keyBatch: KeyBatch?
        if isPaste {
            latestPasteRequest &+= 1
            pendingKeys = nil
            keyBatch = nil
        } else if let pendingKeys, let writeTail {
            pendingKeys.data.append(data)
            return writeTail
        } else {
            keyBatch = KeyBatch(data)
            pendingKeys = keyBatch
        }
        let pasteRequest = isPaste ? latestPasteRequest : nil
        let generation = generation
        let previousWrite = writeTail
        let task = Task { @MainActor [weak self] in
            _ = await previousWrite?.value
            guard let self,
                  self.isCurrent(target: target, generation: generation, pasteRequest: pasteRequest) else {
                return false
            }
            if let keyBatch, self.pendingKeys === keyBatch {
                self.pendingKeys = nil
            }
            let encoded = isPaste ? TerminalInputEncoder.paste(data) : keyBatch?.data ?? data
            for chunk in TerminalInputEncoder.chunks(encoded) {
                guard self.isCurrent(target: target, generation: generation, pasteRequest: pasteRequest),
                      await write(chunk) else {
                    return false
                }
            }
            return true
        }
        writeTail = task
        return task
    }

    private func isCurrent(target: Target, generation: UInt64, pasteRequest: UInt64?) -> Bool {
        isAttached && self.target == target && self.generation == generation
            && (pasteRequest == nil || pasteRequest == latestPasteRequest)
    }
}

public struct FeatureTerminalView: View {
    let client: any FeatureClient
    let threadID: String

    @SwiftUI.Environment(\.dismiss) private var dismiss
    @AppStorage("terminalFontSize") private var storedFontSize = TerminalFontSize.defaultValue
    @State private var terminal: FeatureTerminalSnapshot?
    @State private var sessions = [FeatureTerminalSnapshot]()
    @State private var activeTerminalID = "default"
    @State private var resolvedThreadID: String?
    @State private var columns = 80
    @State private var rows = 24
    @State private var focusRequest = 0
    @State private var surfaceGeneration = 0
    @State private var isLoading = true
    @State private var isOpening = false
    @State private var errorMessage: String?
    @State private var inputSession = TerminalInputSession()

    public init(client: any FeatureClient, threadID: String) {
        self.client = client
        self.threadID = threadID
    }

    public var body: some View {
        let target = inputTarget
        ZStack {
            T3Colors.background

            GhosttyTerminalSurface(
                terminalKey: "\(threadID):\(activeTerminalID)",
                lifecycleVersion: terminal?.lifecycleVersion ?? 0,
                buffer: terminal?.buffer ?? "",
                fontSize: CGFloat(fontSize),
                isRunning: isRunning,
                hostPlatform: TerminalHostPlatform(os: client.terminalHostOS(threadID: threadID)),
                focusRequest: focusRequest,
                onInput: { data in
                    _ = enqueueInput(data, target: target)
                },
                onPaste: { data in
                    _ = enqueueInput(data, target: target, isPaste: true)
                },
                onResize: { nextColumns, nextRows in
                    updateGrid(columns: nextColumns, rows: nextRows)
                },
                onClear: {
                    let terminalID = activeTerminalID
                    Task { await clear(terminalID: terminalID) }
                },
                onFontSizeStep: { direction in
                    stepFontSize(direction)
                }
            )
            .id("\(terminalTaskID):\(fontSize):\(surfaceGeneration)")
            .padding(.top, 48)

            if isLoading, terminal == nil {
                ProgressView("Opening terminal…")
                    .tint(T3Colors.textPrimary)
                    .foregroundStyle(T3Colors.textPrimary)
            } else if let errorMessage, terminal == nil {
                ContentUnavailableView(
                    "Terminal unavailable",
                    systemImage: "terminal",
                    description: Text(errorMessage)
                )
                .foregroundStyle(T3Colors.textPrimary)
            }

            if let errorMessage, terminal != nil {
                VStack {
                    Spacer()
                    Text(errorMessage)
                        .font(T3Typography.supporting)
                        .foregroundStyle(Color.white)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Color.red.opacity(0.88))
                        .accessibilityLabel("Terminal error: \(errorMessage)")
                }
            }

            terminalHeader
        }
        .background(T3Colors.background.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .onAppear { inputSession.attach(to: inputTarget) }
        .onDisappear { inputSession.detach() }
        .onChange(of: threadID) { _, _ in
            updateTerminal(nil)
            sessions = []
            activeTerminalID = "default"
            resolvedThreadID = nil
            errorMessage = nil
        }
        .task(id: threadID) {
            inputSession.updateTarget(inputTarget)
            for await updates in client.terminalSessions(threadID: threadID) {
                guard !Task.isCancelled else { return }
                sessions = updates
                if !sessionsResolved {
                    activeTerminalID = TerminalSessionList.initialID(in: updates)
                    resolvedThreadID = threadID
                }
            }
            guard !Task.isCancelled else { return }
            resolvedThreadID = threadID
        }
        .task(id: terminalTaskID) {
            guard sessionsResolved else { return }
            await loadAndOpen()
        }
        .task(id: terminalTaskID) {
            guard sessionsResolved else { return }
            let terminalID = activeTerminalID
            for await update in client.terminalEvents(
                threadID: threadID,
                terminalID: terminalID
            ) {
                guard !Task.isCancelled, terminalID == activeTerminalID else { break }
                let shouldSyncGrid = !isRunning
                    && (update.state == .running || update.state == .starting)
                let currentBuffer = terminal?.buffer
                guard updateTerminal(update) else { continue }
                if let currentBuffer, !update.buffer.hasPrefix(currentBuffer) {
                    surfaceGeneration += 1
                }
                if shouldSyncGrid {
                    try? await client.resizeTerminal(
                        threadID: threadID,
                        terminalID: terminalID,
                        columns: columns,
                        rows: rows
                    )
                }
                if update.state == .running {
                    errorMessage = nil
                } else if update.state == .failed, let error = update.error {
                    errorMessage = error
                }
            }
        }
    }

    private var terminalHeader: some View {
        VStack(spacing: 0) {
            ZStack {
                Text("Terminal")
                    .font(T3Typography.navigationTitle)
                    .foregroundStyle(T3Colors.textPrimary)

                HStack {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .frame(width: 44, height: 44)
                    }
                    .foregroundStyle(T3Colors.textPrimary)
                    .accessibilityLabel("Close terminal")

                    Spacer()

                    terminalMenu
                        .frame(width: 44, height: 44)
                }
            }
            .frame(height: 48)
            .background(T3Colors.background)

            Spacer(minLength: 0)
        }
    }

    private var terminalMenu: some View {
        Menu {
            Section {
                Label(statusLabel, systemImage: statusSymbol)
                if let workingDirectory = terminal?.workingDirectory {
                    Text(workingDirectory)
                }
            }

            Section("Sessions") {
                ForEach(menuSessions, id: \.terminalID) { session in
                    Button {
                        selectTerminal(session.terminalID)
                    } label: {
                        Label(
                            TerminalSessionList.displayTitle(for: session),
                            systemImage: session.terminalID == activeTerminalID
                                ? "checkmark"
                                : "terminal"
                        )
                    }
                }

                Button {
                    openNewTerminal()
                } label: {
                    Label("Open new terminal", systemImage: "plus")
                }
            }

            Section {
                Menu {
                    Button {
                        stepFontSize(-1)
                    } label: {
                        Label(
                            "Smaller · \(formattedFontSize(fontSize - TerminalFontSize.step)) pt",
                            systemImage: "textformat.size.smaller"
                        )
                    }
                    .disabled(fontSize <= TerminalFontSize.minimum)

                    Button {
                        stepFontSize(1)
                    } label: {
                        Label(
                            "Larger · \(formattedFontSize(fontSize + TerminalFontSize.step)) pt",
                            systemImage: "textformat.size.larger"
                        )
                    }
                    .disabled(fontSize >= TerminalFontSize.maximum)
                } label: {
                    Label("Text size · \(formattedFontSize(fontSize)) pt", systemImage: "textformat.size")
                }

                Button {
                    let terminalID = activeTerminalID
                    Task { await clear(terminalID: terminalID) }
                } label: {
                    Label("Clear", systemImage: "eraser")
                }
                .disabled(terminal == nil)
            }

            Section {
                if isRunning {
                    Button(role: .destructive) {
                        Task { await stop() }
                    } label: {
                        Label("Stop terminal", systemImage: "stop.fill")
                    }
                } else {
                    Button {
                        Task { await open() }
                    } label: {
                        Label("Start terminal", systemImage: "play.fill")
                    }
                    .disabled(isLoading || isOpening)
                }
            }
        } label: {
            Image(systemName: "terminal")
        }
        .accessibilityLabel("Terminal options")
    }

    private var fontSize: Double {
        TerminalFontSize.normalized(storedFontSize)
    }

    private var terminalTaskID: String {
        "\(threadID):\(sessionsResolved):\(activeTerminalID)"
    }

    private var sessionsResolved: Bool {
        resolvedThreadID == threadID
    }

    private var inputTarget: TerminalInputSession.Target? {
        guard let terminal, isRunning,
              terminal.threadID == threadID, terminal.terminalID == activeTerminalID else {
            return nil
        }
        return .init(
            threadID: threadID,
            terminalID: activeTerminalID,
            lifecycleVersion: terminal.lifecycleVersion
        )
    }

    @discardableResult
    private func updateTerminal(_ snapshot: FeatureTerminalSnapshot?) -> Bool {
        if let snapshot {
            guard snapshot.threadID == threadID, snapshot.terminalID == activeTerminalID else {
                return false
            }
            if let terminal,
               terminal.threadID == snapshot.threadID, terminal.terminalID == snapshot.terminalID,
               snapshot.lifecycleVersion < terminal.lifecycleVersion {
                return false
            }
        }
        terminal = snapshot
        inputSession.updateTarget(inputTarget)
        return true
    }

    private var menuSessions: [FeatureTerminalSnapshot] {
        var visible = sessions.filter {
            $0.state == .running || $0.state == .starting || $0.terminalID == activeTerminalID
        }
        if let terminal,
           !visible.contains(where: { $0.terminalID == terminal.terminalID }) {
            visible.append(terminal)
        }
        return visible.sorted {
            $0.terminalID.localizedStandardCompare($1.terminalID) == .orderedAscending
        }
    }

    private var isRunning: Bool {
        terminal?.state == .running || terminal?.state == .starting
    }

    private var statusLabel: String {
        switch terminal?.state {
        case .running: terminal?.hasRunningSubprocess == true ? "Task running" : "Ready"
        case .starting: "Starting"
        case .failed: "Error"
        case .exited: "Exited"
        case .stopped, nil: "Not started"
        }
    }

    private var statusSymbol: String {
        switch terminal?.state {
        case .running: "checkmark.circle.fill"
        case .starting: "clock.fill"
        case .failed: "exclamationmark.triangle.fill"
        case .exited: "xmark.circle.fill"
        case .stopped, nil: "circle"
        }
    }

    private func formattedFontSize(_ value: Double) -> String {
        String(format: "%.1f", TerminalFontSize.normalized(value))
    }

    private func stepFontSize(_ direction: Int) {
        storedFontSize = TerminalFontSize.normalized(
            fontSize + Double(direction) * TerminalFontSize.step
        )
    }

    private func selectTerminal(_ terminalID: String) {
        guard terminalID != activeTerminalID else { return }
        updateTerminal(nil)
        errorMessage = nil
        activeTerminalID = terminalID
    }

    private func openNewTerminal() {
        let nextID = TerminalSessionList.nextID(
            occupiedIDs: sessions.map(\.terminalID) + [activeTerminalID]
        )
        updateTerminal(nil)
        errorMessage = nil
        activeTerminalID = nextID
    }

    private func updateGrid(columns nextColumns: Int, rows nextRows: Int) {
        guard nextColumns != columns || nextRows != rows else { return }
        columns = nextColumns
        rows = nextRows
        guard isRunning else { return }
        let terminalID = activeTerminalID
        Task {
            do {
                try await client.resizeTerminal(
                    threadID: threadID,
                    terminalID: terminalID,
                    columns: nextColumns,
                    rows: nextRows
                )
            } catch {
                if terminalID == activeTerminalID {
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private func loadAndOpen() async {
        let terminalID = activeTerminalID
        isLoading = true
        defer { isLoading = false }
        do {
            let snapshot = try await client.terminalSnapshot(
                threadID: threadID,
                terminalID: terminalID
            )
            guard !Task.isCancelled, terminalID == activeTerminalID else { return }
            guard updateTerminal(snapshot) else { return }
            if snapshot.state == .stopped || snapshot.state == .exited {
                try await openTerminal(terminalID: terminalID)
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func open() async {
        guard !isOpening else { return }
        isOpening = true
        defer { isOpening = false }
        do {
            try await openTerminal(terminalID: activeTerminalID)
            focusRequest += 1
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func openTerminal(terminalID: String) async throws {
        inputSession.updateTarget(nil)
        try await client.openTerminal(
            threadID: threadID,
            terminalID: terminalID,
            columns: columns,
            rows: rows
        )
        guard !Task.isCancelled, terminalID == activeTerminalID else { return }
        let snapshot = try await client.terminalSnapshot(
            threadID: threadID,
            terminalID: terminalID
        )
        guard !Task.isCancelled, terminalID == activeTerminalID else { return }
        updateTerminal(snapshot)
    }

    private func stop() async {
        let terminalID = activeTerminalID
        inputSession.updateTarget(nil)
        let fallbackID = TerminalSessionList.fallbackID(
            in: sessions,
            excluding: terminalID
        )
        do {
            try await client.closeTerminal(threadID: threadID, terminalID: terminalID)
            guard terminalID == activeTerminalID else { return }
            if let fallbackID {
                selectTerminal(fallbackID)
            } else {
                let snapshot = try? await client.terminalSnapshot(
                    threadID: threadID,
                    terminalID: terminalID
                )
                guard terminalID == activeTerminalID else { return }
                updateTerminal(snapshot)
            }
            errorMessage = nil
        } catch {
            if terminalID == activeTerminalID {
                inputSession.updateTarget(inputTarget)
                errorMessage = error.localizedDescription
            }
        }
    }

    private func clear(terminalID: String) async {
        let target = inputTarget
        do {
            if terminalID == activeTerminalID {
                terminal?.buffer = ""
                surfaceGeneration += 1
            }
            try await client.clearTerminal(
                threadID: threadID,
                terminalID: terminalID
            )
            if let target, target.terminalID == terminalID {
                guard let task = enqueueInput("\u{0C}", target: target), await task.value else { return }
            }
            if terminalID == activeTerminalID {
                errorMessage = nil
            }
        } catch {
            if terminalID == activeTerminalID {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func enqueueInput(
        _ data: String,
        target: TerminalInputSession.Target?,
        isPaste: Bool = false
    ) -> Task<Bool, Never>? {
        guard let target else { return nil }
        return inputSession.enqueue(data, target: target, isPaste: isPaste) { chunk in
            await write(chunk, target: target)
        }
    }

    private func write(_ data: String, target: TerminalInputSession.Target) async -> Bool {
        guard target == inputTarget else { return false }
        do {
            try await client.writeTerminal(
                threadID: target.threadID,
                terminalID: target.terminalID,
                data: data
            )
            return true
        } catch {
            if target == inputTarget {
                errorMessage = error.localizedDescription
            }
            return false
        }
    }
}
