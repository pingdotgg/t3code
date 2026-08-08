import Testing
@testable import T3Code

@Suite("Composer power features")
struct FeatureComposerPowerTests {
    @Test
    func detectsCommandsModelsSkillsAndPathsAtTheCursor() {
        #expect(
            FeatureComposerTriggerParser.detect(in: "/re")
                == FeatureComposerTrigger(kind: .slashCommand, query: "re", range: 0..<3)
        )
        #expect(
            FeatureComposerTriggerParser.detect(in: "/model claude")
                == FeatureComposerTrigger(kind: .model, query: "claude", range: 0..<13)
        )
        #expect(
            FeatureComposerTriggerParser.detect(in: "Use $dep")
                == FeatureComposerTrigger(kind: .skill, query: "dep", range: 4..<8)
        )
        #expect(
            FeatureComposerTriggerParser.detect(in: "Read @Sources/App")
                == FeatureComposerTrigger(kind: .path, query: "Sources/App", range: 5..<17)
        )

        let editedText = "Use @Sources/App then continue"
        #expect(
            FeatureComposerTriggerParser.detect(in: editedText, cursorOffset: 16)
                == FeatureComposerTrigger(kind: .path, query: "Sources/App", range: 4..<16)
        )
    }

    @Test
    func replacementsPreserveTextOutsideTheActiveTrigger() {
        let text = "Review @Sources/App please"
        let result = FeatureComposerTriggerParser.replacing(
            7..<19,
            in: text,
            with: "[App](Sources/App) "
        )
        #expect(result == "Review [App](Sources/App)  please")
    }

    @Test
    func fileLinksMatchTheSharedComposerFormat() {
        #expect(
            FeatureComposerFileLinkSerializer.markdownLink(for: "path/to/package.json")
                == "[package.json](path/to/package.json)"
        )
        #expect(
            FeatureComposerFileLinkSerializer.markdownLink(for: "docs/My File (draft).md")
                == "[My File (draft).md](docs/My%20File%20%28draft%29.md)"
        )
        #expect(
            FeatureComposerFileLinkSerializer.markdownLink(for: "C:\\repo\\src\\index.ts")
                == "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)"
        )
        #expect(
            FeatureComposerFileLinkSerializer.markdownLink(for: "@scope/package.json")
                == "[package.json](@scope/package.json)"
        )
    }

    @Test
    func commandMenuIncludesProviderCommandsButNotRemovedMobileModes() throws {
        let trigger = try #require(FeatureComposerTriggerParser.detect(in: "/"))
        let powerFeatures = FeatureComposerPowerFeatures(
            slashCommands: [
                FeatureProviderSlashCommand(name: "review", description: "Review changes"),
                FeatureProviderSlashCommand(name: "plan", description: "Legacy mode"),
                FeatureProviderSlashCommand(name: "default", description: "Legacy mode"),
            ]
        )
        let items = FeatureComposerMenuBuilder.items(
            trigger: trigger,
            providers: [],
            currentSelection: nil,
            threadSelection: nil,
            powerFeatures: powerFeatures,
            pathEntries: []
        )

        #expect(items.map(\.label) == ["/model", "/review"])
    }

    @Test
    func modelAndSkillMenusFilterTheirCatalogs() throws {
        let provider = FeatureProvider(
            id: "claude",
            name: "Claude",
            models: [
                FeatureModel(id: "sonnet", name: "Sonnet"),
                FeatureModel(id: "opus", name: "Opus"),
            ]
        )
        let modelTrigger = try #require(
            FeatureComposerTriggerParser.detect(in: "/model op")
        )
        let modelItems = FeatureComposerMenuBuilder.items(
            trigger: modelTrigger,
            providers: [provider],
            currentSelection: nil,
            threadSelection: nil,
            powerFeatures: .disabled,
            pathEntries: []
        )
        #expect(modelItems.map(\.label) == ["Opus"])

        let skillTrigger = try #require(FeatureComposerTriggerParser.detect(in: "$fix"))
        let skillItems = FeatureComposerMenuBuilder.items(
            trigger: skillTrigger,
            providers: [provider],
            currentSelection: nil,
            threadSelection: nil,
            powerFeatures: FeatureComposerPowerFeatures(
                skills: [
                    FeatureProviderSkill(
                        name: "gh-fix-ci",
                        displayName: "Fix CI",
                        shortDescription: "Repair failing checks"
                    ),
                    FeatureProviderSkill(name: "deploy", displayName: "Deploy")
                ]
            ),
            pathEntries: []
        )
        #expect(skillItems.map(\.label) == ["Fix CI"])
    }

    @Test
    func modelCommandHonorsProvidersThatLockAThreadModel() throws {
        let provider = FeatureProvider(
            id: "locked",
            name: "Locked provider",
            requiresNewThreadForModelChange: true,
            models: [
                FeatureModel(id: "current", name: "Current"),
                FeatureModel(id: "other", name: "Other"),
            ]
        )
        let trigger = try #require(FeatureComposerTriggerParser.detect(in: "/model"))
        let currentSelection = FeatureSelection(
            providerID: "locked",
            modelID: "current",
            options: [FeatureModelOptionSelection(id: "reasoning", value: .string("high"))]
        )
        let items = FeatureComposerMenuBuilder.items(
            trigger: trigger,
            providers: [provider],
            currentSelection: currentSelection,
            threadSelection: currentSelection,
            powerFeatures: .disabled,
            pathEntries: []
        )

        #expect(items.map(\.label) == ["Current"])
        if case let .model(selection, _, _) = try #require(items.first) {
            #expect(selection.options == currentSelection.options)
        } else {
            Issue.record("Expected a model menu item")
        }
    }

    @Test
    func changingInputQuestionsKeepsAValidActiveQuestionAndDropsStaleAnswers() {
        #expect(
            FeatureComposerQuestionReconciliation.index(
                current: 2,
                previousQuestionIDs: ["one", "two", "three"],
                currentQuestionIDs: ["one"]
            ) == 0
        )
        #expect(
            FeatureComposerQuestionReconciliation.index(
                current: 1,
                previousQuestionIDs: ["one", "two", "three"],
                currentQuestionIDs: ["three", "two"]
            ) == 1
        )

        let reconciled = FeatureComposerQuestionReconciliation.answers(
            [
                "one": .text("keep"),
                "removed": .text("drop"),
            ],
            currentQuestionIDs: ["one"]
        )
        #expect(reconciled == ["one": .text("keep")])
    }

    @Test
    func onlyTheExplicitComposerButtonCanSend() {
        #expect(
            FeatureComposerSubmissionPolicy.allowsSend(for: .explicitButton)
        )
        #expect(
            !FeatureComposerSubmissionPolicy.allowsSend(for: .returnKey)
        )
    }
}
