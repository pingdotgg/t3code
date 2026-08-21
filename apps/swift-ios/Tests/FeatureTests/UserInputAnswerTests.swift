import Foundation
import Testing
@testable import T3Code

@Suite("User input answers")
struct UserInputAnswerTests {
    @Test
    func testCodableShapeMatchesProviderWireValues() throws {
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()

        let textData = try encoder.encode(FeatureInputAnswer.text("Deploy"))
        let selectionsData = try encoder.encode(
            FeatureInputAnswer.selections(["Server", "Web"])
        )

        #expect(try decoder.decode(JSONValue.self, from: textData) == .string("Deploy"))
        #expect(
            try decoder.decode(JSONValue.self, from: selectionsData)
                == .array([.string("Server"), .string("Web")])
        )
        #expect(try decoder.decode(FeatureInputAnswer.self, from: textData) == .text("Deploy"))
        #expect(
            try decoder.decode(FeatureInputAnswer.self, from: selectionsData)
                == .selections(["Server", "Web"])
        )
    }

    @Test
    func testNativeJSONMappingPreservesStringAndArrayTypes() {
        #expect(FeatureInputAnswer.text("Deploy").jsonValue == .string("Deploy"))
        #expect(
            FeatureInputAnswer.selections(["Server", "Web"]).jsonValue
                == .array([.string("Server"), .string("Web")])
        )
    }

    @Test
    func testMultiSelectTogglesWithoutFlatteningSelections() {
        let first = FeatureInputAnswer.selections([])
            .togglingOption("Server", allowsMultiple: true)
        let second = first.togglingOption("Web", allowsMultiple: true)
        let deselected = second.togglingOption("Server", allowsMultiple: true)

        #expect(first == .selections(["Server"]))
        #expect(second == .selections(["Server", "Web"]))
        #expect(deselected == .selections(["Web"]))
        #expect(
            second.togglingOption("CLI", allowsMultiple: false)
                == .text("CLI")
        )
    }

    @Test
    func testAnswersNormalizeBeforeSubmission() {
        #expect(FeatureInputAnswer.text("  ship it  ").normalized == .text("ship it"))
        #expect(
            FeatureInputAnswer.selections([" Server ", "", "Server", "Web"]).normalized
                == .selections(["Server", "Web"])
        )
        #expect(FeatureInputAnswer.text("   ").normalized == nil)
        #expect(FeatureInputAnswer.selections([]).normalized == nil)
    }

    @Test
    func testMultiSelectCustomTextStaysInTheSelectionArray() {
        let question = FeatureInputQuestion(
            id: "surfaces",
            header: "Surfaces",
            question: "Where should this ship?",
            options: [
                .init(label: "Server", detail: "Backend"),
                .init(label: "Web", detail: "Browser"),
            ],
            allowsMultiple: true
        )
        let selected = FeatureInputAnswer.selections(["Server"])
        let withCustom = FeatureComposerCustomAnswer.replacingText(
            in: selected,
            with: "CLI",
            for: question
        )

        #expect(withCustom == .selections(["Server", "CLI"]))
        #expect(FeatureComposerCustomAnswer.text(in: withCustom, for: question) == "CLI")
        #expect(
            FeatureComposerCustomAnswer.replacingText(
                in: withCustom,
                with: "",
                for: question
            ) == .selections(["Server"])
        )
    }
}
