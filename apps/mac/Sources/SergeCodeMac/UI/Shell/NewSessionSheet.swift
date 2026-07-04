import SwiftUI

/// Glass sheet for starting a new session: pick an existing project or add
/// a new one by path, choose a provider, and create the thread.
struct NewSessionSheet: View {
    let model: AppModel
    @Binding var isPresented: Bool

    @UIState private var mode: Mode = .existing
    @UIState private var selectedProjectID: String?
    @UIState private var provider: ProviderKind = .claude
    @UIState private var newProjectPath: String = ""
    @UIState private var isBusy = false

    private enum Mode: String, CaseIterable, Identifiable {
        case existing = "Existing Project"
        case new = "New Project"
        var id: String { rawValue }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("New Session")
                .font(.title2.bold())

            Picker("", selection: $mode) {
                ForEach(Mode.allCases) { mode in
                    Text(mode.rawValue).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .onChange(of: mode) { selectedProjectID = nil }

            switch mode {
            case .existing:
                Picker("Project", selection: $selectedProjectID) {
                    Text("Select a project").tag(String?.none)
                    ForEach(model.projects) { project in
                        Text(project.name).tag(Optional(project.id))
                    }
                }
            case .new:
                TextField("Project path", text: $newProjectPath)
                    .textFieldStyle(.roundedBorder)
            }

            Picker("Provider", selection: $provider) {
                ForEach(ProviderKind.allCases) { kind in
                    Text(kind.displayName).tag(kind)
                }
            }

            HStack {
                Spacer()
                Button("Cancel") { isPresented = false }
                    .buttonStyle(.glass)
                Button("Create") {
                    Task { await create() }
                }
                .buttonStyle(.glass)
                .tint(.accentColor)
                .disabled(isBusy || !canCreate)
            }
        }
        .padding(24)
        .frame(width: 420)
        .glassEffect(.regular, in: .rect(cornerRadius: 20))
    }

    private var canCreate: Bool {
        switch mode {
        case .existing: selectedProjectID != nil
        case .new: !newProjectPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private func create() async {
        isBusy = true
        defer { isBusy = false }
        switch mode {
        case .existing:
            guard let projectID = selectedProjectID else { return }
            await model.createThread(projectID: projectID, provider: provider)
        case .new:
            let path = newProjectPath.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !path.isEmpty else { return }
            await model.addProject(path: path)
            if let project = model.projects.first(where: { $0.path == path }) {
                await model.createThread(projectID: project.id, provider: provider)
            }
        }
        isPresented = false
    }
}
