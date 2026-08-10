#!/usr/bin/env swift

import Foundation

struct Entry: Codable {
    let commit: String
    let title: String
    let summary: String
    let pullRequest: Int?
    let pullRequestURL: String?
    let committedAt: String?
}

struct Changelog: Codable {
    let revision: String
    let baseRevision: String?
    let repositoryURL: String?
    let generatedBy: String
    let entries: [Entry]
}

struct Summaries: Codable {
    struct Item: Codable {
        let commit: String
        let summary: String
    }

    let summaries: [Item]
}

struct ApprovedManifest: Decodable {
    struct Item: Decodable {
        let integratedCommit: String
        let pullRequest: String?
    }

    let features: [Item]
    let candidates: [Item]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("[swift-ios-changelog] error: \(message)\n".utf8))
    exit(1)
}

func git(_ arguments: [String], repository: String) -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = ["-C", repository] + arguments
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.standardError
    do { try process.run() } catch { fail("could not launch git: \(error)") }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { fail("git command failed") }
    return String(decoding: data, as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

let arguments = CommandLine.arguments
guard arguments.count == 4 || arguments.count == 5 else {
    fail("usage: generate-build-changelog.swift REPOSITORY BASE_REF OUTPUT [SUMMARIES_JSON]")
}

let repository = arguments[1]
let baseRef = arguments[2]
let outputURL = URL(fileURLWithPath: arguments[3])
let summariesURL = arguments.count == 5 ? URL(fileURLWithPath: arguments[4]) : nil
let summaries: [String: String]
if let summariesURL {
    do {
        let document = try JSONDecoder().decode(Summaries.self, from: Data(contentsOf: summariesURL))
        var values: [String: String] = [:]
        for item in document.summaries {
            guard values.updateValue(item.summary, forKey: item.commit) == nil else {
                fail("summaries JSON contains duplicate commit \(item.commit)")
            }
        }
        summaries = values
    } catch {
        fail("could not decode summaries JSON: \(error)")
    }
} else {
    summaries = [:]
}

let revision = git(["rev-parse", "HEAD"], repository: repository)
let baseRevision = git(["rev-parse", baseRef], repository: repository)
let rawRepositoryURL = git(["remote", "get-url", "upstream"], repository: repository)
let repositoryURL: String? = {
    var value = rawRepositoryURL.replacingOccurrences(of: #"\.git$"#, with: "", options: .regularExpression)
    if value.hasPrefix("git@") {
        value = "https://" + value.dropFirst("git@".count).replacingOccurrences(of: ":", with: "/")
    } else if value.hasPrefix("ssh://git@") {
        value = "https://" + value.dropFirst("ssh://git@".count)
    }
    return value.hasPrefix("https://") ? value : nil
}()
let approvedPullRequests: [String: String] = {
    let url = URL(fileURLWithPath: repository)
        .appending(path: "scripts/t3-swift-approved/manifest.json")
    guard let data = try? Data(contentsOf: url),
          let manifest = try? JSONDecoder().decode(ApprovedManifest.self, from: data)
    else { return [:] }
    return Dictionary(uniqueKeysWithValues: (manifest.features + manifest.candidates).compactMap {
        guard let pullRequest = $0.pullRequest else { return nil }
        return ($0.integratedCommit, pullRequest)
    })
}()
let fieldSeparator = Character("\u{1f}")
let recordSeparator = Character("\u{1e}")
let log = git([
    "log", "--reverse", "--date=iso-strict",
    "--format=%H%x1f%s%x1f%b%x1f%cI%x1e", "\(baseRef)..HEAD",
], repository: repository)
let pullRequestPattern = try! NSRegularExpression(pattern: #"\(#(\d+)\)$"#)
let entries = log.split(separator: recordSeparator).compactMap { record -> Entry? in
    let fields = record.split(separator: fieldSeparator, omittingEmptySubsequences: false)
    guard fields.count >= 4 else { return nil }
    let commit = String(fields[0]).trimmingCharacters(in: .whitespacesAndNewlines)
    let title = String(fields[1]).trimmingCharacters(in: .whitespacesAndNewlines)
    let body = String(fields[2]).trimmingCharacters(in: .whitespacesAndNewlines)
    let date = String(fields[3]).trimmingCharacters(in: .whitespacesAndNewlines)
    let range = NSRange(title.startIndex..<title.endIndex, in: title)
    let pullRequest = pullRequestPattern.firstMatch(in: title, range: range).flatMap { match in
        Range(match.range(at: 1), in: title).flatMap { Int(title[$0]) }
    }
    let approvedPullRequestURL = approvedPullRequests[commit]
    let pullRequestURL = approvedPullRequestURL
        ?? pullRequest.flatMap { number in repositoryURL.map { "\($0)/pull/\(number)" } }
    let resolvedPullRequest = approvedPullRequestURL.flatMap { URL(string: $0)?.lastPathComponent }
        .flatMap(Int.init) ?? pullRequest
    let fallback = body.split(separator: "\n").first.map(String.init) ?? title
    return Entry(
        commit: commit,
        title: title,
        summary: summaries[commit] ?? summaries[String(commit.prefix(12))] ?? fallback,
        pullRequest: resolvedPullRequest,
        pullRequestURL: pullRequestURL,
        committedAt: date.isEmpty ? nil : date
    )
}

if !summaries.isEmpty {
    let missing = entries.filter {
        summaries[$0.commit] == nil && summaries[String($0.commit.prefix(12))] == nil
    }
    guard missing.isEmpty else {
        fail("Luna summaries are missing for \(missing.count) commit(s)")
    }
    let includedCommits = Set(entries.map(\.commit))
    let unexpected = summaries.keys.filter { summaryCommit in
        !includedCommits.contains(summaryCommit)
            && !entries.contains(where: { $0.commit.hasPrefix(summaryCommit) })
    }
    guard unexpected.isEmpty else {
        fail("Luna summaries contain \(unexpected.count) unexpected commit(s)")
    }
}

let changelog = Changelog(
    revision: revision,
    baseRevision: baseRevision,
    repositoryURL: repositoryURL,
    generatedBy: summaries.isEmpty ? "Git history" : "GPT-5.6 Luna",
    entries: entries
)
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
do {
    try encoder.encode(changelog).write(to: outputURL, options: .atomic)
} catch {
    fail("could not write changelog: \(error)")
}
