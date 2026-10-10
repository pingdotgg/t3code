import Foundation
import Testing
@testable import T3Code

@Suite("Context compaction")
struct FeatureContextCompactionTests {
    @Test
    func commandRequiresExactTextWithoutAttachments() {
        #expect(FeatureContextCompaction.isCommand(" /COMPACT\n", hasAttachments: false))
        #expect(!FeatureContextCompaction.isCommand("/compact", hasAttachments: true))
        #expect(!FeatureContextCompaction.isCommand("/compact the last turn", hasAttachments: false))
        #expect(!FeatureContextCompaction.isCommand("Explain /compact", hasAttachments: false))
    }

    @Test
    func newThreadsAndUnsentMessagesHaveNoContextToCompact() {
        #expect(!FeatureContextCompaction.canStart(in: nil, isBusy: false))
        let histories: [[FeatureMessage]] = [
            [],
            [.init(id: "assistant", role: .assistant, text: "Ready")],
            [.init(id: "compact", role: .user, text: "/compact")],
            [.init(id: "blank", role: .user, text: " \n")],
            [.init(id: "queued", role: .user, text: "Build the app", state: .queued)],
        ]
        for messages in histories {
            #expect(!FeatureContextCompaction.canStart(in: detail(messages: messages), isBusy: false))
        }
    }

    @Test
    func priorTextAndAttachmentMessagesCanBeCompacted() {
        #expect(FeatureContextCompaction.canStart(in: detail(), isBusy: false))
        let attachment = FeatureMessageAttachment(
            id: "reference",
            name: "reference.png",
            mimeType: "image/png",
            sizeBytes: 10
        )
        let imageMessage = FeatureMessage(
            id: "image",
            role: .user,
            text: "",
            attachments: [attachment]
        )
        #expect(FeatureContextCompaction.canStart(
            in: detail(messages: [imageMessage]),
            isBusy: false
        ))
    }

    @Test
    func busyThreadsCannotStartAnotherCompaction() {
        #expect(!FeatureContextCompaction.canStart(in: detail(), isBusy: true))
        for state in [
            FeatureThreadState.queued, .working, .monitoring, .waitingForApproval, .waitingForInput,
        ] {
            var active = detail()
            active.thread.state = state
            #expect(!FeatureContextCompaction.canStart(in: active, isBusy: false))
        }
        var compacting = detail()
        compacting.isCompacting = true
        #expect(!FeatureContextCompaction.canStart(in: compacting, isBusy: false))
    }

    @Test
    func earlierConversationCountsWhenHistoryIsPaginated() {
        var paginated = detail(messages: [])
        paginated.page = FeatureThreadPage(beforeCursor: "older", hasMore: true)
        #expect(!FeatureContextCompaction.canStart(in: paginated, isBusy: false))
        paginated.thread.settlementFacts = FeatureThreadSettlementFacts(
            latestUserMessageAt: Date(timeIntervalSince1970: 10)
        )
        #expect(FeatureContextCompaction.canStart(in: paginated, isBusy: false))
    }

    @Test
    func commandMenuOnlyOffersCompactionForAnAvailableConversation() {
        let commands = [
            FeatureProviderSlashCommand(name: "compact"),
            FeatureProviderSlashCommand(name: "status"),
        ]
        let hidden = commandNames(in: FeatureComposerPowerFeatures(slashCommands: commands))
        #expect(hidden == ["status"])
        let available = commandNames(in: FeatureComposerPowerFeatures(
            slashCommands: commands,
            canCompactContext: FeatureContextCompaction.canStart(in: detail(), isBusy: false)
        ))
        #expect(available == ["compact", "status"])
    }

    private func detail(
        messages: [FeatureMessage] = [.init(id: "user", role: .user, text: "Build the app")]
    ) -> FeatureThreadDetail {
        FeatureThreadDetail(
            thread: FeatureThread(id: "thread", projectID: "project", title: "Task"),
            messages: messages
        )
    }

    private func commandNames(in features: FeatureComposerPowerFeatures) -> [String] {
        FeatureComposerMenuBuilder.items(
            trigger: .init(kind: .slashCommand, query: "", range: 0..<1),
            providers: [],
            currentSelection: nil,
            threadSelection: nil,
            powerFeatures: features,
            pathEntries: []
        ).compactMap { item in
            guard case let .providerCommand(command) = item else { return nil }
            return command.name
        }
    }
}
