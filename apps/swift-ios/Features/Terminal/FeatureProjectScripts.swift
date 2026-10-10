import Foundation
import SwiftUI

@MainActor
public protocol FeatureProjectScriptRunning: AnyObject {
    func configuredProjectScripts(threadID: String) async throws -> [ProjectScript]
    func runProjectScript(threadID: String, scriptID: String, columns: Int, rows: Int,
                          hasSessionSnapshot: Bool) async throws -> String
}

extension NativeFeatureClient: FeatureProjectScriptRunning {}

enum FeatureProjectScriptSettings {
    /// Matches project override, folded defaults, then the legacy script sources.
    static func resolve(settings: ServerSettingsSnapshot, projectID: String, scripts: [ProjectScript]) -> [ProjectScript] {
        if let override = settings.projectSettingsOverrides[projectID]?["defaultProjectScripts"],
           let decoded = try? override.decode([ProjectScript].self) { return decoded }
        if settings.projectSettingsFolded { return settings.defaultProjectScripts }
        if let legacy = settings.projectScriptOverrides[projectID] {
            if legacy == .null { return settings.defaultProjectScripts }
            if let decoded = try? legacy.decode([ProjectScript].self) { return decoded }
        }
        return scripts.isEmpty ? settings.defaultProjectScripts : scripts
    }
}

struct FeatureProjectScriptLaunch: Equatable, Sendable {
    let cwd: String
    let worktreePath: String?
    let environmentVariables: [String: String]
    let input: String

    init(projectRoot: String, worktreePath: String?, command: String) {
        cwd = worktreePath ?? projectRoot
        self.worktreePath = worktreePath
        var variables = ["T3CODE_PROJECT_ROOT": projectRoot]
        if let worktreePath, !worktreePath.isEmpty { variables["T3CODE_WORKTREE_PATH"] = worktreePath }
        environmentVariables = variables
        input = command + "\r"
    }

    static func terminalID(threadID: String, sessions: [FeatureTerminalSnapshot]?) -> String {
        // Older hosts can open terminals without providing session metadata.
        // Use a new identity rather than risk writing into an unknown running shell.
        guard let sessions else { return "script-\(UUID().uuidString.lowercased())" }
        let threadSessions = sessions.filter { $0.threadID == threadID }
        if !threadSessions.contains(where: { $0.state == .running || $0.state == .starting }) { return "default" }
        return TerminalSessionList.nextID(occupiedIDs: threadSessions.map(\.terminalID))
    }

    /// Opening must finish before input is sent. Revalidate between suspension points.
    @MainActor
    func execute(
        validate: () throws -> Void,
        open: () async throws -> Void,
        write: (String) async throws -> Void
    ) async throws {
        try Task.checkCancellation()
        try validate()
        try await open()
        for chunk in TerminalInputEncoder.chunks(input) {
            try Task.checkCancellation()
            try validate()
            try await write(chunk)
        }
    }
}

extension ProjectScript {
    var menuLabel: String {
        var roles: [String] = []
        if runOnWorktreeCreate { roles.append("setup") }
        if runOnSettle == true { roles.append("on settle") }
        return roles.isEmpty ? name : "\(name) (\(roles.joined(separator: ", ")))"
    }

    var menuSymbol: String {
        switch icon {
        case "test": "flask"
        case "lint": "checklist"
        case "configure": "wrench.and.screwdriver"
        case "build": "hammer"
        case "debug": "ladybug"
        default: "play"
        }
    }
}

/// Can be mounted in the thread controls or the terminal's existing menu.
/// The owner presents launch errors from outside the menu's content.
public struct FeatureProjectScriptsMenu: View {
    let client: any FeatureClient
    let threadID: String
    let columns: Int
    let rows: Int
    let onError: (String) -> Void
    let onLaunch: (String) -> Void

    @State private var scripts: [ProjectScript] = []
    @State private var loadedThreadID: String?
    @State private var isLoading = false
    @State private var isLaunching = false
    @State private var sessionsReady = false
    @State private var errorMessage: String?

    public init(client: any FeatureClient, threadID: String, columns: Int = 80, rows: Int = 24,
                onError: @escaping (String) -> Void,
                onLaunch: @escaping (String) -> Void) {
        self.client = client
        self.threadID = threadID
        self.columns = columns
        self.rows = rows
        self.onError = onError
        self.onLaunch = onLaunch
    }

    public var body: some View {
        if client is any FeatureProjectScriptRunning {
            Menu {
                if isLoading { Text("Loading scripts…") }
                if let errorMessage { Text(errorMessage) }
                if loadedThreadID == threadID {
                    ForEach(scripts) { script in
                        Button {
                            Task { await launch(script) }
                        } label: {
                            Label(script.menuLabel, systemImage: script.menuSymbol)
                        }
                        .disabled(isLaunching)
                    }
                    if scripts.isEmpty, !isLoading, errorMessage == nil { Text("No configured scripts") }
                }
                Button("Reload scripts", systemImage: "arrow.clockwise") {
                    Task { await load() }
                }
                .disabled(isLoading || isLaunching)
            } label: {
                Label(isLaunching ? "Starting script…" : "Project scripts", systemImage: "play")
            }
            .task(id: threadID) { await load() }
            .task(id: threadID) {
                // Keep native session metadata current before selecting a free terminal.
                sessionsReady = false
                for await _ in client.terminalSessions(threadID: threadID) {
                    guard !Task.isCancelled else { return }
                    sessionsReady = true
                }
                if !Task.isCancelled { sessionsReady = false }
            }
        }
    }

    private func load() async {
        guard let runner = client as? any FeatureProjectScriptRunning else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let scripts = try await runner.configuredProjectScripts(threadID: threadID)
            try Task.checkCancellation()
            self.scripts = scripts
            loadedThreadID = threadID
            errorMessage = nil
        } catch {
            guard !Task.isCancelled, !(error is CancellationError) else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func launch(_ script: ProjectScript) async {
        guard !isLaunching, let runner = client as? any FeatureProjectScriptRunning else { return }
        isLaunching = true
        defer { isLaunching = false }
        do {
            let terminalID = try await runner.runProjectScript(
                threadID: threadID, scriptID: script.id, columns: columns, rows: rows,
                hasSessionSnapshot: sessionsReady
            )
            errorMessage = nil
            onLaunch(terminalID)
        } catch {
            onError(error.localizedDescription)
        }
    }
}
