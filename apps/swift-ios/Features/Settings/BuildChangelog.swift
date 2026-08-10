import Foundation
import SwiftUI

struct BuildChangelog: Codable, Equatable, Sendable {
    struct Entry: Codable, Equatable, Identifiable, Sendable {
        let commit: String
        let title: String
        let summary: String
        let pullRequest: Int?
        let committedAt: Date?

        var id: String { commit }
        var shortCommit: String { String(commit.prefix(7)) }
    }

    let revision: String
    let baseRevision: String?
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
                    ForEach(Array(changelog.entries.enumerated()), id: \.element.id) { index, entry in
                        milestone(entry, isLast: index == changelog.entries.count - 1)
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

    private func milestone(_ entry: BuildChangelog.Entry, isLast: Bool) -> some View {
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
                HStack(spacing: 8) {
                    if let pullRequest = entry.pullRequest { Text("PR #\(pullRequest)") }
                    Text(entry.shortCommit)
                }
                .font(.caption.monospaced())
                .foregroundStyle(T3Colors.textTertiary)
            }
            .padding(.bottom, isLast ? 0 : 22)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }
}
