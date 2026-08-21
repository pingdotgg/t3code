import SwiftUI
import Testing
import UIKit
import UniformTypeIdentifiers
@testable import T3Code

@Suite("Composer power features")
struct FeatureComposerPowerTests {
    @Test(
        "Composer input grows past the former seven-line cap",
        .bug("https://github.com/saphid/t3code-personal/issues/105")
    )
    func composerTextInputGrowsBeyondSevenLines() {
        let lineHeight: CGFloat = 22
        let sevenLines = FeatureComposerTextInputSizing.height(
            fittingHeight: lineHeight * 7,
            lineHeight: lineHeight
        )
        let elevenLines = FeatureComposerTextInputSizing.height(
            fittingHeight: lineHeight * 11,
            lineHeight: lineHeight
        )

        #expect(sevenLines == lineHeight * 7)
        #expect(elevenLines == lineHeight * 11)
    }

    @Test(
        "A very tall composer input caps at its line bound and scrolls inside",
        .bug("https://github.com/saphid/t3code-personal/issues/105")
    )
    func composerTextInputCapsAtItsLineBound() {
        #expect(
            FeatureComposerTextInputSizing.height(
                fittingHeight: 2_200,
                lineHeight: 22
            ) == 22 * FeatureComposerTextInputSizing.maximumLines
        )
    }

    @Test
    func replacementCursorLandsAfterInsertedTextInUTF16() {
        // "🧪 " occupies three characters but four UTF-16 units; the caret
        // location must count the latter or it drifts on emoji-bearing drafts.
        let original = "🧪 Use $dep please"
        let range = 6..<10

        #expect(
            FeatureComposerTextSelectionPolicy.cursorLocation(
                afterReplacing: range,
                in: original,
                with: "$dependency "
            ) == "🧪 Use $dependency ".utf16.count
        )
    }

    @Test
    func restoredDraftPlacesCaretAtUTF16End() {
        #expect(
            FeatureComposerTextSelectionPolicy.cursorLocationAfterBindingUpdate(
                previousText: "",
                newText: "🧪 restored draft",
                selectedLocation: 0
            ) == "🧪 restored draft".utf16.count
        )
    }

    @Test
    func externalRewriteClampsCaretIntoTheNewText() {
        #expect(
            FeatureComposerTextSelectionPolicy.cursorLocationAfterBindingUpdate(
                previousText: "a much longer draft",
                newText: "short",
                selectedLocation: 19
            ) == 5
        )
    }

    @Test
    @MainActor
    func imageCapableComposerAdvertisesImagesToTheNativePasteMenu() {
        let textView = FeatureComposerUITextView()

        textView.acceptsImages = true

        #expect(
            textView.pasteConfiguration?.acceptableTypeIdentifiers.contains(
                UTType.image.identifier
            ) == true
        )
        #expect(
            textView.pasteConfiguration?.acceptableTypeIdentifiers.contains(
                UTType.text.identifier
            ) == true
        )

        textView.acceptsImages = false

        #expect(textView.pasteConfiguration == nil)
    }

    @Test
    @MainActor
    func textViewDeclinesImageDropsSoTheComposerSurfaceOwnsThem() {
        let textView = FeatureComposerUITextView()
        textView.acceptsImages = true

        let image = NSItemProvider()
        image.registerDataRepresentation(
            forTypeIdentifier: UTType.png.identifier,
            visibility: .all
        ) { completion in
            completion(Data([0x89, 0x50, 0x4E, 0x47]), nil)
            return nil
        }
        let text = NSItemProvider(object: "caption" as NSString)

        #expect(!textView.canPaste([image]))
        #expect(!textView.canPaste([text, image]))
        #expect(textView.canPaste([text]))
    }

    @Test
    func downwardDragDismissalRespectsDraftScrolling() {
        #expect(FeatureComposerDragDismissPolicy.shouldDismiss(
            translationX: 2, translationY: 20, isScrollable: false, isAtTop: true
        ))
        // Scrolling back through a capped draft must not drop the keyboard…
        #expect(!FeatureComposerDragDismissPolicy.shouldDismiss(
            translationX: 2, translationY: 20, isScrollable: true, isAtTop: false
        ))
        // …but a drag that begins at the top of the draft only rubber-bands,
        // and is the capped composer's one escape hatch.
        #expect(FeatureComposerDragDismissPolicy.shouldDismiss(
            translationX: 2, translationY: 20, isScrollable: true, isAtTop: true
        ))
        // Mostly-horizontal drags are caret adjustments, not dismissals.
        #expect(!FeatureComposerDragDismissPolicy.shouldDismiss(
            translationX: 30, translationY: 12, isScrollable: false, isAtTop: true
        ))
        #expect(!FeatureComposerDragDismissPolicy.shouldDismiss(
            translationX: 0, translationY: 8, isScrollable: false, isAtTop: true
        ))
    }

    @Test
    func nativePasteDetectionUsesImageTypeConformance() {
        let pasteboard = UIPasteboard.withUniqueName()
        defer { UIPasteboard.remove(withName: pasteboard.name) }
        pasteboard.items = [
            [UTType.heic.identifier: Data([0x00])],
        ]

        #expect(!pasteboard.hasImages)
        #expect(FeatureComposerPasteboardPolicy.containsImage(in: pasteboard))
    }

    @Test
    func nativePasteDetectionChecksEveryPasteboardItem() {
        let pasteboard = UIPasteboard.withUniqueName()
        defer { UIPasteboard.remove(withName: pasteboard.name) }
        pasteboard.items = [
            [UTType.plainText.identifier: "caption"],
            [UTType.png.identifier: Data([0x89, 0x50, 0x4E, 0x47])],
        ]

        #expect(FeatureComposerPasteboardPolicy.containsImage(in: pasteboard))
    }

    @Test(
        "Reasoning label follows the effective composer selection",
        .bug("https://github.com/saphid/t3code-personal/issues/106")
    )
    func reasoningLabelFollowsEffectiveSelectionAndMaterializesInvalidModels() {
        let providers = [
            FeatureProvider(
                id: "codex",
                name: "Codex",
                models: [
                    FeatureModel(
                        id: "sol",
                        name: "A deliberately long model name that must truncate",
                        options: [
                            .init(
                                id: "reasoningEffort",
                                label: "Reasoning effort",
                                kind: .select,
                                choices: [
                                    .init(id: "low", label: "Low"),
                                    .init(id: "high", label: "High"),
                                ]
                            ),
                        ]
                    ),
                ]
            ),
        ]
        let inherited = FeatureSelection(
            providerID: "codex",
            modelID: "sol",
            options: [.init(id: "reasoningEffort", value: .string("low"))]
        )
        let current = FeatureSelection(
            providerID: "codex",
            modelID: "sol",
            options: [.init(id: "reasoningEffort", value: .string("high"))]
        )

        #expect(
            FeatureComposerReasoningControl.resolve(
                explicit: current,
                inherited: inherited,
                providers: providers,
                materializesDefaultSelection: false
            )?.value == "High"
        )
        #expect(
            FeatureComposerReasoningControl.resolve(
                explicit: nil,
                inherited: inherited,
                providers: providers,
                materializesDefaultSelection: false
            )?.value == "Low"
        )
        #expect(
            FeatureComposerReasoningControl.resolve(
                explicit: .init(providerID: "codex", modelID: "missing"),
                inherited: nil,
                providers: providers,
                materializesDefaultSelection: true
            )?.value == "Low"
        )
    }

    @Test(
        "The reasoning selector offers exactly the descriptor's own levels",
        .bug("https://github.com/saphid/t3code-personal/issues/110")
    )
    func reasoningSelectorOffersDescriptorLevelsAndMarksTheCurrentOne() {
        let providers = [Self.solProvider]
        let selection = FeatureSelection(
            providerID: "codex",
            modelID: "gpt-5.6-sol",
            options: [
                .init(id: "reasoningEffort", value: .string("high")),
                .init(id: "serviceTier", value: .string("default")),
            ]
        )

        let control = FeatureComposerReasoningControl.resolve(
            explicit: selection,
            inherited: nil,
            providers: providers,
            materializesDefaultSelection: true
        )

        #expect(control?.isInteractive == true)
        #expect(control?.descriptorID == "reasoningEffort")
        #expect(control?.descriptorLabel == "Reasoning effort")
        #expect(control?.value == "High")
        #expect(control?.currentChoiceID == "high")
        #expect(
            control?.choices.map(\.id) == ["low", "medium", "high", "xhigh", "max", "ultra"]
        )
        #expect(
            control?.choices.map(\.label)
                == ["Low", "Medium", "High", "Extra high", "Max", "Ultra"]
        )
    }

    @Test(
        "The reasoning selector materializes the same default model as the adjacent picker",
        .bug("https://github.com/pingdotgg/t3code/pull/7344#discussion_r3826822638")
    )
    func reasoningSelectorMaterializesTheDefaultModel() {
        let control = FeatureComposerReasoningControl.resolve(
            explicit: nil,
            inherited: nil,
            providers: [Self.solProvider],
            materializesDefaultSelection: true
        )

        #expect(control?.value == "Low")
        #expect(control?.currentChoiceID == "low")
        #expect(control?.selection(choosing: "high").providerID == "codex")
        #expect(control?.selection(choosing: "high").modelID == "gpt-5.6-sol")
    }

    @Test(
        "Choosing a level writes the model selection the picker would write",
        .bug("https://github.com/saphid/t3code-personal/issues/110")
    )
    func choosingALevelWritesTheSelectedOptionValueAndKeepsTheOtherOptions() {
        let providers = [Self.solProvider]
        let inherited = FeatureSelection(
            providerID: "codex",
            modelID: "gpt-5.6-sol",
            options: [
                .init(id: "reasoningEffort", value: .string("low")),
                .init(id: "serviceTier", value: .string("default")),
            ]
        )

        let control = FeatureComposerReasoningControl.resolve(
            explicit: nil,
            inherited: inherited,
            providers: providers,
            materializesDefaultSelection: false
        )
        let written = control?.selection(choosing: "xhigh")

        #expect(written?.providerID == "codex")
        #expect(written?.modelID == "gpt-5.6-sol")
        #expect(
            written?.options.first(where: { $0.id == "reasoningEffort" })?.value == .string("xhigh")
        )
        #expect(
            written?.options.first(where: { $0.id == "serviceTier" })?.value == .string("default")
        )
        #expect(written?.options.filter { $0.id == "reasoningEffort" }.count == 1)

        // The write must survive the effective-selection policy the composer
        // reads back, otherwise the level would silently revert.
        #expect(
            FeatureComposerReasoningControl.resolve(
                explicit: written,
                inherited: inherited,
                providers: providers,
                materializesDefaultSelection: false
            )?.value == "Extra high"
        )
    }

    @Test(
        "The reasoning control hides or stays read-only exactly as the label did",
        .bug("https://github.com/saphid/t3code-personal/issues/110")
    )
    func reasoningControlHidesWithoutADescriptorAndStaysReadOnlyForToggles() {
        let plainProvider = FeatureProvider(
            id: "plain",
            name: "Plain",
            models: [FeatureModel(id: "basic", name: "Basic")]
        )
        let togglingProvider = FeatureProvider(
            id: "toggling",
            name: "Toggling",
            models: [
                FeatureModel(
                    id: "thinker",
                    name: "Thinker",
                    options: [
                        .init(id: "thinking", label: "Extended thinking", kind: .boolean),
                    ]
                ),
            ]
        )

        // No reasoning descriptor at all: nothing to show and nothing to change.
        #expect(
            FeatureComposerReasoningControl.resolve(
                explicit: .init(providerID: "plain", modelID: "basic"),
                inherited: nil,
                providers: [plainProvider],
                materializesDefaultSelection: true
            ) == nil
        )

        // A boolean descriptor keeps the previous summary behavior: visible while
        // enabled, hidden while disabled, and never an inline level selector.
        let enabled = FeatureComposerReasoningControl.resolve(
            explicit: .init(
                providerID: "toggling",
                modelID: "thinker",
                options: [.init(id: "thinking", value: .boolean(true))]
            ),
            inherited: nil,
            providers: [togglingProvider],
            materializesDefaultSelection: true
        )
        #expect(enabled?.value == "Extended thinking")
        #expect(enabled?.isInteractive == false)
        #expect(enabled?.choices.isEmpty == true)
        #expect(enabled?.currentChoiceID == nil)
        #expect(
            FeatureComposerReasoningControl.resolve(
                explicit: .init(
                    providerID: "toggling",
                    modelID: "thinker",
                    options: [.init(id: "thinking", value: .boolean(false))]
                ),
                inherited: nil,
                providers: [togglingProvider],
                materializesDefaultSelection: true
            ) == nil
        )

        // An unknown persisted level is not a level this model can offer, so the
        // control stays hidden instead of inventing one.
        #expect(
            FeatureComposerReasoningControl.resolve(
                explicit: .init(
                    providerID: "codex",
                    modelID: "gpt-5.6-sol",
                    options: [.init(id: "reasoningEffort", value: .string("galaxy"))]
                ),
                inherited: nil,
                providers: [Self.solProvider],
                materializesDefaultSelection: true
            ) == nil
        )
    }

    @Test(
        "The selector drops the two ultra tiers and keeps the descriptor's order",
        .bug("https://github.com/saphid/t3code-personal/issues/110")
    )
    func reasoningSelectorExcludesUltraTiersAndOffersTheRestLowestFirst() {
        let providers = [Self.claudeProvider]
        let selection = FeatureSelection(
            providerID: "claudeAgent",
            modelID: "claude-opus-5",
            options: [.init(id: "effort", value: .string("high"))]
        )

        let control = FeatureComposerReasoningControl.resolve(
            explicit: selection,
            inherited: nil,
            providers: providers,
            materializesDefaultSelection: true
        )

        // Lowest first, in the descriptor's own order, with exactly the two
        // excluded tiers missing and nothing else dropped or reordered.
        #expect(control?.choices.map(\.id) == ["low", "medium", "high", "xhigh", "max"])
        #expect(
            control?.choices.map(\.label) == ["Low", "Medium", "High", "Extra High", "Max"]
        )
        #expect(control?.choices.contains { $0.id == "ultracode" } == false)
        #expect(control?.choices.contains { $0.id == "ultrathink" } == false)
        #expect(control?.isInteractive == true)
        #expect(control?.currentChoiceID == "high")
        #expect(FeatureComposerReasoningControl.excludedChoiceIDs == ["ultracode", "ultrathink"])

        // Codex's separate `ultra` level was not part of the verdict and is a
        // different descriptor id, so it must survive untouched.
        let codexControl = FeatureComposerReasoningControl.resolve(
            explicit: .init(
                providerID: "codex",
                modelID: "gpt-5.6-sol",
                options: [.init(id: "reasoningEffort", value: .string("low"))]
            ),
            inherited: nil,
            providers: [Self.solProvider],
            materializesDefaultSelection: true
        )
        #expect(codexControl?.choices.map(\.id).contains("ultra") == true)
    }

    @Test(
        "An excluded level stays visible when it is already the effective one",
        .bug("https://github.com/saphid/t3code-personal/issues/110")
    )
    func excludedLevelIsStillReportedButNeverOfferedOrChecked() {
        let control = FeatureComposerReasoningControl.resolve(
            explicit: .init(
                providerID: "claudeAgent",
                modelID: "claude-opus-5",
                options: [.init(id: "effort", value: .string("ultrathink"))]
            ),
            inherited: nil,
            providers: [Self.claudeProvider],
            materializesDefaultSelection: true
        )

        // The composer must not lie about the current setting, but it also must
        // not offer it or mark a row that is no longer in the menu.
        #expect(control?.value == "Ultrathink")
        #expect(control?.currentChoiceID == nil)
        #expect(control?.choices.contains { $0.id == "ultrathink" } == false)

        // Choosing an offered level still replaces the excluded one cleanly.
        let written = control?.selection(choosing: "max")
        #expect(written?.options.first(where: { $0.id == "effort" })?.value == .string("max"))
        #expect(written?.options.filter { $0.id == "effort" }.count == 1)
    }

    @Test(
        "A descriptor offering only excluded tiers becomes read-only",
        .bug("https://github.com/saphid/t3code-personal/issues/110")
    )
    func aDescriptorOfOnlyExcludedTiersLeavesAReadOnlyLabel() {
        let provider = FeatureProvider(
            id: "claudeAgent",
            name: "Claude",
            models: [
                FeatureModel(
                    id: "ultra-only",
                    name: "Ultra only",
                    options: [
                        .init(
                            id: "effort",
                            label: "Reasoning",
                            kind: .select,
                            choices: [
                                .init(id: "ultracode", label: "Ultracode", isDefault: true),
                                .init(id: "ultrathink", label: "Ultrathink"),
                            ]
                        ),
                    ]
                ),
            ]
        )

        let control = FeatureComposerReasoningControl.resolve(
            explicit: .init(providerID: "claudeAgent", modelID: "ultra-only"),
            inherited: nil,
            providers: [provider],
            materializesDefaultSelection: true
        )

        #expect(control?.value == "Ultracode")
        #expect(control?.choices.isEmpty == true)
        #expect(control?.isInteractive == false)
    }

    /// Mirrors the `effort` descriptor the Claude provider advertises, which is
    /// where the two excluded tiers actually come from.
    private static let claudeProvider = FeatureProvider(
        id: "claudeAgent",
        name: "Claude",
        models: [
            FeatureModel(
                id: "claude-opus-5",
                name: "Claude Opus 5",
                isDefault: true,
                options: [
                    .init(
                        id: "effort",
                        label: "Reasoning",
                        kind: .select,
                        choices: [
                            .init(id: "low", label: "Low"),
                            .init(id: "medium", label: "Medium"),
                            .init(id: "high", label: "High", isDefault: true),
                            .init(id: "xhigh", label: "Extra High"),
                            .init(id: "max", label: "Max"),
                            .init(id: "ultracode", label: "Ultracode"),
                            .init(id: "ultrathink", label: "Ultrathink"),
                        ]
                    ),
                ]
            ),
        ]
    )

    /// Mirrors the descriptor the Codex provider actually advertises for
    /// `gpt-5.6-sol`, including the neighbouring option the selector must not
    /// disturb.
    private static let solProvider = FeatureProvider(
        id: "codex",
        name: "Codex",
        models: [
            FeatureModel(
                id: "gpt-5.6-sol",
                name: "GPT-5.6-Sol",
                isDefault: true,
                options: [
                    .init(
                        id: "reasoningEffort",
                        label: "Reasoning effort",
                        kind: .select,
                        choices: [
                            .init(id: "low", label: "Low", isDefault: true),
                            .init(id: "medium", label: "Medium"),
                            .init(id: "high", label: "High"),
                            .init(id: "xhigh", label: "Extra high"),
                            .init(id: "max", label: "Max"),
                            .init(id: "ultra", label: "Ultra"),
                        ]
                    ),
                    .init(
                        id: "serviceTier",
                        label: "Service tier",
                        kind: .select,
                        choices: [.init(id: "default", label: "Standard", isDefault: true)]
                    ),
                ]
            ),
        ]
    )

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
