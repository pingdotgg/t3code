import Testing
@testable import T3Mobile

struct ShellViewModelTests {
    @Test @MainActor func initializesWithFirstAvailableSelections() {
        let viewModel = ShellViewModel.preview()

        #expect(viewModel.selectedEnvironmentID == "environment-preview")
        #expect(viewModel.selectedProjectID == "project-preview")
        #expect(viewModel.selectedThreadID == "thread-preview")
        #expect(viewModel.selectedThread?.title == "Mobile sync gateway")
        #expect(viewModel.threadSections.first?.threads.count == 1)
        #expect(viewModel.projectID(forThreadID: "thread-preview") == "project-preview")
    }
}
