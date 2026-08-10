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

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("[swift-ios-changelog] error: \(message)\n".utf8))
    exit(1)
}

func git(_ arguments: [String], repository: String, required: Bool = true) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = ["-C", repository] + arguments
    let output = Pipe()
    process.standardOutput = output
    process.standardError = required ? FileHandle.standardError : Pipe()
    do { try process.run() } catch { fail("could not launch git: \(error)") }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        if required { fail("git command failed: \(arguments.joined(separator: " "))") }
        return nil
    }
    return String(decoding: data, as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

let arguments = CommandLine.arguments
guard arguments.count == 4 else {
    fail("usage: generate-build-changelog.swift REPOSITORY BASE_REF OUTPUT")
}

let repository = arguments[1]
let baseRef = arguments[2]
let outputURL = URL(fileURLWithPath: arguments[3])
let revision = git(["rev-parse", "HEAD"], repository: repository, required: false) ?? "unknown"
let baseRevision = git(["rev-parse", baseRef], repository: repository, required: false)
let rawRepositoryURL = git(
    ["remote", "get-url", "upstream"], repository: repository, required: false
) ?? git(["remote", "get-url", "origin"], repository: repository, required: false)
let repositoryURL: String? = {
    guard var value = rawRepositoryURL else { return nil }
    value = value.replacingOccurrences(of: #"\.git$"#, with: "", options: .regularExpression)
    if value.hasPrefix("git@") {
        value = "https://" + value.dropFirst("git@".count).replacingOccurrences(of: ":", with: "/")
    } else if value.hasPrefix("ssh://git@") {
        value = "https://" + value.dropFirst("ssh://git@".count)
    }
    return value.hasPrefix("https://") ? value : nil
}()
let fieldSeparator = Character("\u{1f}")
let recordSeparator = Character("\u{1e}")
let log: String
if baseRevision == nil || revision == "unknown" {
    FileHandle.standardError.write(
        Data("[swift-ios-changelog] warning: Git history is unavailable; embedding an empty changelog\n".utf8)
    )
    log = ""
} else {
    log = git([
        "log", "--reverse", "--date=iso-strict",
        "--format=%H%x1f%s%x1f%b%x1f%cI%x1e", "\(baseRef)..HEAD",
    ], repository: repository)!
}
let pullRequestPattern = try! NSRegularExpression(pattern: #"\(#(\d+)\)$"#)
var entries = log.split(separator: recordSeparator).compactMap { record -> Entry? in
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
    let pullRequestURL = pullRequest.flatMap { number in repositoryURL.map { "\($0)/pull/\(number)" } }
    let fallback = body.split(separator: "\n").first.map(String.init) ?? title
    return Entry(
        commit: commit,
        title: title,
        summary: fallback,
        pullRequest: pullRequest,
        pullRequestURL: pullRequestURL,
        committedAt: date.isEmpty ? nil : date
    )
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
do {
    var omittedCount = 0
    var data: Data
    repeat {
        let generatedBy = omittedCount == 0
            ? "Git history"
            : "Git history · \(omittedCount) older changes omitted"
        data = try encoder.encode(Changelog(
            revision: revision,
            baseRevision: baseRevision,
            repositoryURL: repositoryURL,
            generatedBy: generatedBy,
            entries: entries
        ))
        guard data.base64EncodedString().utf8.count > 49_152,
              !entries.isEmpty else { break }
        entries.removeFirst()
        omittedCount += 1
    } while true
    guard data.base64EncodedString().utf8.count <= 49_152 else {
        fail("changelog metadata exceeds the 48 KiB encoded build-setting limit")
    }
    try data.write(to: outputURL, options: .atomic)
} catch {
    fail("could not write changelog: \(error)")
}
