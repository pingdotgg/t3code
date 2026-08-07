import SwiftUI

private enum TerminalFontSize {
    static let minimum = 6.0
    static let maximum = 14.0
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

public struct FeatureTerminalView: View {
    let client: any FeatureClient
    let threadID: String

    @SwiftUI.Environment(\.dismiss) private var dismiss
    @AppStorage("terminalFontSize") private var storedFontSize = TerminalFontSize.defaultValue
    @State private var terminal: FeatureTerminalSnapshot?
    @State private var sessions = [FeatureTerminalSnapshot]()
    @State private var activeTerminalID = "default"
    @State private var sessionsResolved = false
    @State private var columns = 80
    @State private var rows = 24
    @State private var focusRequest = 0
    @State private var surfaceGeneration = 0
    @State private var isLoading = true
    @State private var isOpening = false
    @State private var errorMessage: String?

    public init(client: any FeatureClient, threadID: String) {
        self.client = client
        self.threadID = threadID
    }

    public var body: some View {
        ZStack {
            Color.black

            GhosttyTerminalSurface(
                terminalKey: "\(threadID):\(activeTerminalID)",
                buffer: terminal?.buffer ?? "",
                fontSize: CGFloat(fontSize),
                isRunning: isRunning,
                focusRequest: focusRequest,
                onInput: { data in
                    Task { await write(data) }
                },
                onResize: { nextColumns, nextRows in
                    updateGrid(columns: nextColumns, rows: nextRows)
                },
                onClear: {
                    Task { await clear() }
                },
                onFontSizeStep: { direction in
                    stepFontSize(direction)
                }
            )
            .id("\(terminalTaskID):\(fontSize):\(surfaceGeneration)")
            .padding(.top, 48)

            if isLoading, terminal == nil {
                ProgressView("Opening terminal…")
                    .tint(.white)
                    .foregroundStyle(.white)
            } else if let errorMessage, terminal == nil {
                ContentUnavailableView(
                    "Terminal unavailable",
                    systemImage: "terminal",
                    description: Text(errorMessage)
                )
                .foregroundStyle(.white)
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
        .background(Color.black.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .task {
            for await updates in client.terminalSessions(threadID: threadID) {
                sessions = updates
                if !sessionsResolved {
                    activeTerminalID = TerminalSessionList.initialID(in: updates)
                    sessionsResolved = true
                }
            }
            sessionsResolved = true
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
                guard terminalID == activeTerminalID else { break }
                let shouldSyncGrid = !isRunning
                    && (update.state == .running || update.state == .starting)
                if let currentBuffer = terminal?.buffer,
                   !update.buffer.hasPrefix(currentBuffer) {
                    surfaceGeneration += 1
                }
                terminal = update
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
                    .foregroundStyle(.white)

                HStack {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .frame(width: 44, height: 44)
                    }
                    .foregroundStyle(.white)
                    .accessibilityLabel("Close terminal")

                    Spacer()

                    terminalMenu
                        .frame(width: 44, height: 44)
                }
            }
            .frame(height: 48)
            .background(Color.black)

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
                    Task { await clear() }
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
        "\(sessionsResolved):\(activeTerminalID)"
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
        terminal = nil
        errorMessage = nil
        activeTerminalID = terminalID
    }

    private func openNewTerminal() {
        let nextID = TerminalSessionList.nextID(
            occupiedIDs: sessions.map(\.terminalID) + [activeTerminalID]
        )
        terminal = nil
        errorMessage = nil
        activeTerminalID = nextID
    }

    private func updateGrid(columns nextColumns: Int, rows nextRows: Int) {
        guard nextColumns != columns || nextRows != rows else { return }
        columns = nextColumns
        rows = nextRows
        guard isRunning else { return }
        Task {
            do {
                try await client.resizeTerminal(
                    threadID: threadID,
                    terminalID: activeTerminalID,
                    columns: nextColumns,
                    rows: nextRows
                )
            } catch {
                errorMessage = error.localizedDescription
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
            guard terminalID == activeTerminalID else { return }
            terminal = snapshot
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
        try await client.openTerminal(
            threadID: threadID,
            terminalID: terminalID,
            columns: columns,
            rows: rows
        )
        guard terminalID == activeTerminalID else { return }
        terminal = try await client.terminalSnapshot(
            threadID: threadID,
            terminalID: terminalID
        )
    }

    private func stop() async {
        let terminalID = activeTerminalID
        let fallbackID = TerminalSessionList.fallbackID(
            in: sessions,
            excluding: terminalID
        )
        do {
            try await client.closeTerminal(threadID: threadID, terminalID: terminalID)
            if let fallbackID {
                selectTerminal(fallbackID)
            } else {
                terminal = try? await client.terminalSnapshot(
                    threadID: threadID,
                    terminalID: terminalID
                )
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func clear() async {
        do {
            terminal?.buffer = ""
            surfaceGeneration += 1
            try await client.clearTerminal(
                threadID: threadID,
                terminalID: activeTerminalID
            )
            if isRunning {
                try await client.writeTerminal(
                    threadID: threadID,
                    terminalID: activeTerminalID,
                    data: "\u{0C}"
                )
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func write(_ data: String) async {
        do {
            try await client.writeTerminal(
                threadID: threadID,
                terminalID: activeTerminalID,
                data: data
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
