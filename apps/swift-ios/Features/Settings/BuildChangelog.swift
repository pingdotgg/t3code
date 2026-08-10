import Foundation
import SwiftUI

struct BuildChangelog: Codable, Equatable, Sendable {
    struct Entry: Codable, Equatable, Identifiable, Sendable {
        let commit: String
        let title: String
        let summary: String
        let pullRequest: Int?
        let pullRequestURL: URL?
        let committedAt: Date?

        var id: String { commit }
        var shortCommit: String { String(commit.prefix(7)) }
    }

    let revision: String
    let baseRevision: String?
    let repositoryURL: URL?
    let generatedBy: String
    let entries: [Entry]

    static func load(info: [String: Any]?) -> BuildChangelog? {
        guard let encoded = info?["T3BuildChangelog"] as? String,
              !encoded.isEmpty,
              !encoded.hasPrefix("$("),
              let data = Data(base64Encoded: encoded)
        else { return nil }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(BuildChangelog.self, from: data)
    }
}

struct BuildChangelogView: View {
    let changelog: BuildChangelog?
    let versionLabel: String

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                header.padding(.bottom, 24)

                if let changelog, !changelog.entries.isEmpty {
                    if let latest = changelog.entries.last {
                        latestChange(latest, repositoryURL: changelog.repositoryURL)
                            .padding(.bottom, 28)
                    }

                    let earlierEntries = Array(changelog.entries.dropLast().reversed())
                    if !earlierEntries.isEmpty {
                        Text("Earlier in this build")
                            .font(T3Typography.homeTitle)
                            .foregroundStyle(T3Colors.textPrimary)
                            .padding(.bottom, 16)
                    }
                    ForEach(Array(earlierEntries.enumerated()), id: \.element.id) { index, entry in
                        milestone(
                            entry,
                            repositoryURL: changelog.repositoryURL,
                            isLast: index == earlierEntries.count - 1
                        )
                    }
                } else {
                    ContentUnavailableView(
                        "No build changelog",
                        systemImage: "list.bullet.rectangle",
                        description: Text("This build did not include an embedded changelog.")
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.top, 48)
                }
            }
            .padding(20)
        }
        .background(T3Colors.background)
        .navigationTitle("What’s in this build")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Version \(versionLabel)")
                .font(T3Typography.homeTitle)
                .foregroundStyle(T3Colors.textPrimary)
            if let changelog {
                Text("Revision \(String(changelog.revision.prefix(7))) · Summaries by \(changelog.generatedBy)")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func latestChange(_ entry: BuildChangelog.Entry, repositoryURL: URL?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("New in this version", systemImage: "sparkles")
                .font(T3Typography.homeTitle)
                .foregroundStyle(T3Colors.accent)
            Text(entry.title)
                .font(T3Typography.threadBody)
                .fontWeight(.semibold)
                .foregroundStyle(T3Colors.textPrimary)
            Text(entry.summary)
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            changeLinks(entry, repositoryURL: repositoryURL)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .stroke(T3Colors.border, lineWidth: 1)
        }
    }

    private func milestone(
        _ entry: BuildChangelog.Entry,
        repositoryURL: URL?,
        isLast: Bool
    ) -> some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(spacing: 0) {
                Circle()
                    .fill(T3Colors.accent)
                    .frame(width: 10, height: 10)
                    .padding(.top, 5)
                if !isLast {
                    Rectangle()
                        .fill(T3Colors.border)
                        .frame(width: 2)
                        .frame(minHeight: 92)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(entry.title)
                    .font(T3Typography.threadBody)
                    .fontWeight(.semibold)
                    .foregroundStyle(T3Colors.textPrimary)
                Text(entry.summary)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                changeLinks(entry, repositoryURL: repositoryURL)
            }
            .padding(.bottom, isLast ? 0 : 22)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func changeLinks(
        _ entry: BuildChangelog.Entry,
        repositoryURL: URL?
    ) -> some View {
        HStack(spacing: 12) {
            if let repositoryURL {
                Link(destination: repositoryURL.appending(path: "commit/\(entry.commit)")) {
                    Label(entry.shortCommit, systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                }
            } else {
                Text(entry.shortCommit)
            }
            if let pullRequest = entry.pullRequest, let pullRequestURL = entry.pullRequestURL {
                Link(destination: pullRequestURL) {
                    Label("PR #\(pullRequest)", systemImage: "arrow.triangle.pull")
                }
            }
        }
        .font(.caption.monospaced())
        .foregroundStyle(T3Colors.accent)
    }
}
