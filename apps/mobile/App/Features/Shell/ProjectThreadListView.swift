import SwiftUI

struct ProjectThreadListView: View {
    let sections: [MobileThreadSection]
    @Binding var selectedProjectID: MobileProject.ID?
    @Binding var selectedThreadID: MobileThread.ID?
    let projectIDForThreadID: (MobileThread.ID?) -> MobileProject.ID?

    var body: some View {
        List(selection: $selectedThreadID) {
            ForEach(sections) { section in
                Section(section.title) {
                    ForEach(section.threads) { thread in
                        ThreadRowView(thread: thread)
                            .tag(thread.id)
                            .listRowSeparator(.hidden)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Chats")
        .overlay {
            if sections.isEmpty || sections.allSatisfy(\.threads.isEmpty) {
                ContentUnavailableView(
                    "No Chats",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text(MobileDesign.placeholderMessage)
                )
            }
        }
        .onChange(of: selectedThreadID, updateSelectedProject)
    }

    private func updateSelectedProject() {
        selectedProjectID = projectIDForThreadID(selectedThreadID)
    }
}

#Preview {
    @Previewable @State var selectedProjectID: MobileProject.ID? = "project-preview"
    @Previewable @State var selectedThreadID: MobileThread.ID? = "thread-preview"

    NavigationStack {
        ProjectThreadListView(
            sections: ShellViewModel.preview().threadSections,
            selectedProjectID: $selectedProjectID,
            selectedThreadID: $selectedThreadID,
            projectIDForThreadID: ShellViewModel.preview().projectID(forThreadID:)
        )
    }
}
