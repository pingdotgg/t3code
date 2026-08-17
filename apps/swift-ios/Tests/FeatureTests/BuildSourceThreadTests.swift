import Foundation
import Testing
@testable import T3Code

@Suite("Build source thread")
struct BuildSourceThreadTests {
    private let now = Date(timeIntervalSince1970: 20_000)

    private func thread(
        id: String,
        wireID: String? = nil,
        environmentID: String? = nil,
        title: String = "Link a development build to its source T3 thread",
        updatedAt: Date? = nil
    ) -> FeatureThread {
        FeatureThread(
            id: id,
            wireID: wireID,
            projectID: "project",
            environmentID: environmentID,
            title: title,
            updatedAt: updatedAt ?? now
        )
    }

    @Test
    func embeddedMetadataIsReadFromTheInfoDictionary() {
        let recorded = BuildSourceThread.recorded(in: [
            "T3SourceThreadID": "  508739B1-477F-4CAB-BA79-8816FCCEA000  ",
            "T3SourceThreadEnvironmentID": "env-1",
            "T3SourceThreadTitle": "Build thread link",
        ])

        #expect(recorded?.threadID == "508739B1-477F-4CAB-BA79-8816FCCEA000")
        #expect(recorded?.environmentID == "env-1")
        #expect(recorded?.recordedTitle == "Build thread link")
    }

    @Test
    func buildsWithoutUsableMetadataRecordNothing() {
        #expect(BuildSourceThread.recorded(in: nil) == nil)
        #expect(BuildSourceThread.recorded(in: [:]) == nil)
        // An unset build setting expands to an empty string.
        #expect(BuildSourceThread.recorded(in: ["T3SourceThreadID": "   "]) == nil)
        // A misconfigured build can leave the literal placeholder behind.
        #expect(BuildSourceThread.recorded(in: ["T3SourceThreadID": "$(T3CODE_SOURCE_THREAD_ID)"]) == nil)
        #expect(BuildSourceThread.recorded(in: ["T3SourceThreadID": 42]) == nil)
    }

    @Test
    func optionalMetadataFieldsFallAwayIndividually() {
        let recorded = BuildSourceThread.recorded(in: [
            "T3SourceThreadID": "thread-1",
            "T3SourceThreadEnvironmentID": "",
            "T3SourceThreadTitle": "$(T3CODE_SOURCE_THREAD_TITLE)",
        ])

        #expect(recorded?.threadID == "thread-1")
        #expect(recorded?.environmentID == nil)
        #expect(recorded?.recordedTitle == nil)
    }

    @Test
    func aBuildWithoutMetadataShowsANoninteractiveRow() {
        let presentation = BuildSourceThreadResolver.presentation(
            for: nil,
            in: FeatureSnapshot(threads: [thread(id: "thread-1")])
        )

        #expect(presentation == .notRecorded)
        #expect(presentation.isInteractive == false)
        #expect(presentation.title == "Not recorded")
        #expect(presentation.detail == "This build did not record a source thread.")
    }

    @Test
    func aLocalThreadIsOpenableByItsExistingIdentity() {
        let presentation = BuildSourceThreadResolver.presentation(
            for: BuildSourceThread(threadID: "thread-1", environmentID: "env-1"),
            in: FeatureSnapshot(
                threads: [
                    thread(id: "other", environmentID: "env-1", title: "Unrelated"),
                    thread(id: "thread-1", environmentID: "env-1"),
                ]
            )
        )

        #expect(
            presentation == .openable(
                threadID: "thread-1",
                title: "Link a development build to its source T3 thread"
            )
        )
        #expect(presentation.isInteractive)
        #expect(presentation.detail == nil)
    }

    @Test
    func aRecordedWireIdentifierResolvesToTheLocalThreadIdentity() {
        let presentation = BuildSourceThreadResolver.presentation(
            for: BuildSourceThread(threadID: "wire-9", environmentID: "env-1"),
            in: FeatureSnapshot(
                threads: [thread(id: "local-9", wireID: "wire-9", environmentID: "env-1")]
            )
        )

        #expect(presentation == .openable(
            threadID: "local-9",
            title: "Link a development build to its source T3 thread"
        ))
    }

    @Test
    func aThreadThatIsNotOnThisDeviceStaysNoninteractive() {
        let presentation = BuildSourceThreadResolver.presentation(
            for: BuildSourceThread(
                threadID: "thread-1",
                environmentID: "env-1",
                recordedTitle: "Build thread link"
            ),
            in: FeatureSnapshot(threads: [thread(id: "thread-2", environmentID: "env-1")])
        )

        #expect(presentation == .unresolved(title: "Build thread link"))
        #expect(presentation.isInteractive == false)
        #expect(presentation.detail == "Not available on this device.")
    }

    @Test
    func aThreadFromAnotherEnvironmentIsNeverSubstituted() {
        let presentation = BuildSourceThreadResolver.presentation(
            for: BuildSourceThread(threadID: "thread-1", environmentID: "env-1"),
            in: FeatureSnapshot(threads: [thread(id: "thread-1", environmentID: "env-2")])
        )

        #expect(presentation.isInteractive == false)
        #expect(presentation.title == "Thread thread-1")
    }

    @Test
    func anAmbiguousMatchWithoutARecordedEnvironmentIsRefused() {
        let snapshot = FeatureSnapshot(
            threads: [
                thread(id: "thread-1", environmentID: "env-1"),
                thread(id: "thread-1", environmentID: "env-2"),
            ]
        )

        let presentation = BuildSourceThreadResolver.presentation(
            for: BuildSourceThread(threadID: "thread-1"),
            in: snapshot
        )

        #expect(presentation.isInteractive == false)
    }

    @Test
    func anUnambiguousMatchWithoutARecordedEnvironmentStillOpens() {
        let presentation = BuildSourceThreadResolver.presentation(
            for: BuildSourceThread(threadID: "thread-1"),
            in: FeatureSnapshot(
                threads: [
                    thread(id: "thread-1", environmentID: "env-1"),
                    thread(id: "thread-2", environmentID: "env-2"),
                ]
            )
        )

        #expect(presentation.isInteractive)
        #expect(presentation == .openable(
            threadID: "thread-1",
            title: "Link a development build to its source T3 thread"
        ))
    }

    @Test
    func theMostRecentlyUpdatedMatchWinsInsideOneEnvironment() {
        let presentation = BuildSourceThreadResolver.presentation(
            for: BuildSourceThread(threadID: "shared", environmentID: "env-1"),
            in: FeatureSnapshot(
                threads: [
                    thread(
                        id: "older",
                        wireID: "shared",
                        environmentID: "env-1",
                        title: "Older",
                        updatedAt: now.addingTimeInterval(-600)
                    ),
                    thread(
                        id: "newer",
                        wireID: "shared",
                        environmentID: "env-1",
                        title: "Newer",
                        updatedAt: now
                    ),
                ]
            )
        )

        #expect(presentation == .openable(threadID: "newer", title: "Newer"))
    }

    @Test
    func anUntitledThreadFallsBackToAShortenedIdentifier() {
        let presentation = BuildSourceThreadResolver.presentation(
            for: BuildSourceThread(threadID: "508739B1-477F-4CAB-BA79-8816FCCEA000"),
            in: FeatureSnapshot(
                threads: [
                    thread(id: "508739B1-477F-4CAB-BA79-8816FCCEA000", title: "   "),
                ]
            )
        )

        #expect(presentation == .openable(
            threadID: "508739B1-477F-4CAB-BA79-8816FCCEA000",
            title: "Thread 508739B1"
        ))
    }
}
