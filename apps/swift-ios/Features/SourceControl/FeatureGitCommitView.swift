import SwiftUI

struct FeatureGitCommitView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let status: FeatureSourceControlStatus
    let action: FeatureSourceControlAction
    let canCreateBranch: Bool
    let submit: (FeatureSourceControlRequest) -> Void
    @State private var message = ""
    @State private var selection: FeatureCommitSelection

    init(status: FeatureSourceControlStatus, action: FeatureSourceControlAction, canCreateBranch: Bool = true, submit: @escaping (FeatureSourceControlRequest) -> Void) {
        self.status = status
        self.action = action
        self.canCreateBranch = canCreateBranch
        self.submit = submit
        _selection = State(initialValue: FeatureCommitSelection(files: status.files))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Commit message (optional)", text: $message, axis: .vertical)
                        .lineLimit(3...8)
                        .accessibilityLabel("Commit message")
                } footer: {
                    Text("Leave the message empty to generate it from the selected changes.")
                }
                Section {
                    HStack {
                        Text("\(selection.paths.count) of \(status.files.count) files")
                        Spacer()
                        Button(selection.paths.isEmpty ? "Select all" : "Clear") {
                            selection.paths = selection.paths.isEmpty ? Set(status.files.map(\.path)) : []
                        }
                    }
                    ForEach(status.files) { file in
                        Button {
                            if selection.paths.contains(file.path) { selection.paths.remove(file.path) }
                            else { selection.paths.insert(file.path) }
                        } label: {
                            HStack {
                                Image(systemName: selection.paths.contains(file.path) ? "checkmark.square.fill" : "square")
                                Text(file.path).font(T3Typography.tool)
                                    .foregroundStyle(T3Colors.textPrimary)
                            }
                        }
                        .accessibilityLabel(file.path)
                        .accessibilityValue(selection.paths.contains(file.path) ? "Included" : "Excluded")
                    }
                } header: {
                    Text("Files to commit")
                }
                Section {
                    Button(action.title) { commit(featureBranch: false) }
                    Button("Commit on new branch") { commit(featureBranch: true) }
                        .disabled(!canCreateBranch)
                }
                .disabled(selection.paths.isEmpty || message.utf16.count > 10_000)
                if message.utf16.count > 10_000 {
                    Text("Commit messages must be at most 10,000 characters.")
                        .foregroundStyle(T3Colors.danger)
                }
            }
            .scrollContentBackground(.hidden)
            .background(T3Colors.background)
            .navigationTitle("Commit changes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }

    private func commit(featureBranch: Bool) {
        guard !selection.paths.isEmpty else { return }
        submit(.init(action: action, message: message, filePaths: selection.filePaths(in: status.files), featureBranch: featureBranch))
    }
}
