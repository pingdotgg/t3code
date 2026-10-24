import SwiftUI
import UIKit

struct FeatureThreadPullRequestsView: View {
  let model: FeatureRootModel
  let threadID: String
  let fallbackThread: FeatureThread
  let openURL: (URL) -> Void
  @SwiftUI.Environment(\.dismiss) private var dismiss
  @State private var showsLinkPrompt = false
  @State private var reference = ""
  @State private var errorMessage: String?
  @State private var isUpdating = false

  private var thread: FeatureThread {
    model.snapshot.threads.first { $0.id == threadID } ?? model.details[threadID]?.thread
      ?? fallbackThread
  }
  private var links: [ThreadPullRequestLink] {
    let chains = ThreadPullRequests.chains(ThreadPullRequests.visible(thread.pullRequests ?? []))
    return
      (chains.filter { $0.contains(where: \.isOpen) }
      + chains.filter { !$0.contains(where: \.isOpen) }).flatMap { $0 }
  }
  private var canOperate: Bool {
    model.client.permissions(forThreadID: threadID)?.grants("orchestration:operate") == true
  }

  var body: some View {
    List {
      if links.isEmpty {
        Text("No linked pull requests.")
      } else {
        Text("\(links.filter(\.isOpen).count) open · \(links.count) linked")
          .font(T3Typography.supporting)
        ForEach(links) { link in
          linkedRow(link)
        }
      }
    }
    .scrollContentBackground(.hidden)
    .background(Color.black)
    .foregroundStyle(.white)
    .tint(.white)
    .navigationTitle("Linked pull requests")
    .navigationBarTitleDisplayMode(.inline)
    .t3NavigationChrome()
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button("Close", systemImage: "xmark") { dismiss() }.labelStyle(.iconOnly)
      }
      if canOperate, thread.supportsMultiplePullRequests == true {
        ToolbarItem(placement: .primaryAction) {
          Button("Link pull request", systemImage: "plus") {
            reference = ""
            showsLinkPrompt = true
          }
          .labelStyle(.iconOnly).disabled(isUpdating)
        }
      }
    }
    .alert("Link pull request", isPresented: $showsLinkPrompt) {
      TextField("Pull request URL or #42", text: $reference)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
      Button("Link") {
        update {
          let repository = model.snapshot.projects.first { $0.id == thread.projectID }?
            .repositoryIdentity
          let url = try FeaturePullRequestLinkInput.resolve(reference, repository: repository)
          try await model.client.setThreadPullRequest(id: threadID, url: url, linked: true)
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Paste a pull request URL, or enter 123 / #123 for this thread's repository.")
    }
    .alert(
      "Could not update pull request",
      isPresented: Binding(
        get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } }
      )
    ) {
      Button("OK") { errorMessage = nil }
    } message: {
      Text(errorMessage ?? "")
    }
  }

  private func linkedRow(_ link: ThreadPullRequestLink) -> some View {
    HStack(alignment: .top) {
      Button {
        if let url = URL(string: link.url) { openURL(url) }
      } label: {
        HStack(alignment: .top, spacing: 8) {
          Image(
            systemName: link.snapshot?.isDraft == true
              ? "doc" : (link.snapshot?.state.systemImage ?? "arrow.triangle.pull")
          )
          .foregroundStyle(
            link.snapshot?.isDraft == true
              ? T3Colors.textSecondary : (link.snapshot?.state.color ?? T3Colors.textSecondary))
          VStack(alignment: .leading, spacing: 4) {
            Text(link.snapshot?.title ?? "\(link.repository)#\(link.number)")
              .font(T3Typography.control).lineLimit(2)
            Text("\(link.repository)#\(link.number)")
              .font(T3Typography.supporting)
            if link.isWatched && link.isOpen {
              Label("Watching", systemImage: "eye").font(T3Typography.supporting)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(Rectangle())
        }
      }
      .buttonStyle(.plain)
      actions(for: link)
        .disabled(isUpdating)
        .accessibilityLabel("Actions for pull request \(link.number)")
    }
  }

  private func actions(for link: ThreadPullRequestLink) -> some View {
    Menu {
      Button("Copy link", systemImage: "link") { UIPasteboard.general.string = link.url }
      if let url = URL(string: link.url) {
        Button("Open in browser", systemImage: "safari") { openURL(url) }
        ShareLink(item: url)
      }
      if canOperate, thread.supportsPullRequestWatching == true, link.isOpen,
        link.isWatched || (!thread.isArchived && !thread.isSettled && !thread.isSubagent)
      {
        Button(
          link.isWatched ? "Stop watching" : "Watch for changes",
          systemImage: link.isWatched ? "eye.slash" : "eye"
        ) {
          update {
            try await model.client.setThreadPullRequestWatching(
              id: threadID, key: link.id, watching: !link.isWatched
            )
          }
        }
      }
      if canOperate, thread.supportsMultiplePullRequests == true {
        Button(role: .destructive) {
          update {
            try await model.client.setThreadPullRequest(id: threadID, url: link.url, linked: false)
          }
        } label: {
          Label(
            link.source == "stack" ? "Dismiss from thread" : "Unlink from thread",
            systemImage: "xmark")
        }
      }
    } label: {
      Image(systemName: "ellipsis").frame(width: 44, height: 44)
    }
  }

  private func update(_ operation: @escaping @MainActor () async throws -> Void) {
    guard !isUpdating else { return }
    isUpdating = true
    Task {
      defer { isUpdating = false }
      do { try await operation() } catch { errorMessage = error.localizedDescription }
    }
  }
}
