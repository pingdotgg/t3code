// SettingsSaveHandlingTests.swift
// `AppModel.saveSettings` returns false when the newest save failed, and every
// Settings call site writes an optimistic `draft` before awaiting it — so a
// caller that drops the result leaves the UI showing a value the server
// rejected. One did (the per-project auto-review override picker), and review
// caught it rather than the compiler: dropping `@discardableResult` does not
// help, because `Task { await model.saveSettings(next) }` is a
// single-expression closure whose `Bool` becomes the task's return type and is
// therefore never "unused".
//
// There is no Swift linter in this repo's checks, so guard the invariant by
// reading the sources. Coarse, but it fails loudly on the exact regression.

import Foundation
import Testing

@Suite("Settings save results are handled")
struct SettingsSaveHandlingTests {

    /// Settings UI files that call `saveSettings`. Kept explicit so a new tab
    /// that starts saving has to be added here consciously.
    private static let settingsSources = [
        "UI/Settings/SettingsScene.swift",
        "UI/Settings/AutoReviewSettingsTab.swift",
        "UI/Settings/WorkflowRoutingSettingsTab.swift",
    ]

    /// Walks up from this file to `apps/mac`, so the test does not depend on
    /// the working directory the suite happens to be launched from.
    private static var sourceRoot: URL {
        var dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // SergeCodeMacTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
        dir.append(path: "Sources/SergeCodeMac")
        return dir
    }

    @Test("every Settings saveSettings call consumes the failure result")
    func everyCallSiteHandlesFailure() throws {
        var unhandled: [String] = []

        for relative in Self.settingsSources {
            let url = Self.sourceRoot.appending(path: relative)
            let contents = try String(contentsOf: url, encoding: .utf8)
            for (offset, line) in contents.components(separatedBy: "\n").enumerated() {
                guard line.contains("model.saveSettings(") else { continue }
                // The established shape is `if await model.saveSettings(x) == false { … }`.
                // Anything else — notably a bare `Task { await model.saveSettings(x) }` —
                // silently discards the failure signal.
                if !line.contains("== false") {
                    unhandled.append("\(relative):\(offset + 1): \(line.trimmingCharacters(in: .whitespaces))")
                }
            }
        }

        #expect(
            unhandled.isEmpty,
            """
            saveSettings call sites that ignore the failure result:
            \(unhandled.joined(separator: "\n"))
            Each one leaves the optimistic draft showing a value the server rejected.
            Use `if await model.saveSettings(next) == false { rollbackDraft() }`.
            """)
    }

    /// Guards the guard: if the call sites move or get renamed, the scan above
    /// would pass by finding nothing at all.
    @Test("the scan actually sees the call sites")
    func scanIsNotVacuous() throws {
        var found = 0
        for relative in Self.settingsSources {
            let url = Self.sourceRoot.appending(path: relative)
            let contents = try String(contentsOf: url, encoding: .utf8)
            found += contents.components(separatedBy: "\n")
                .filter { $0.contains("model.saveSettings(") }.count
        }
        #expect(found >= 8)
    }
}
