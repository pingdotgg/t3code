// WireCodingTests.swift
// Shared codec configuration (§5.1, §5.7) and the reusable optionality/default
// helpers (§5.3, §5.4) that every wire model depends on.

import Testing
@testable import T3Kit
import Foundation

@Suite("WireCoding")
struct WireCodingTests {

    @Test("encodeFrameString produces one compact JSON object, no pretty-printing")
    func encodeFrameStringIsCompact() throws {
        let text = try WireCoding.encodeFrameString(["_tag": "Ping"])
        #expect(!text.contains("\n"))
        let roundTripped = try WireCoding.decoder.decode(JSONValue.self, from: Data(text.utf8))
        #expect(roundTripped == .object(["_tag": .string("Ping")]))
    }

    // MARK: - OptionBox (`Schema.Option` = {_tag:"None"} | {_tag:"Some",value})

    @Test("OptionBox decodes the Some case")
    func optionBoxDecodesSome() throws {
        let box = try WireCoding.decoder.decode(
            OptionBox<String>.self,
            from: Data(FixtureFrames.optionSome.utf8)
        )
        #expect(box.value == "origin/main")
    }

    @Test("OptionBox decodes the None case")
    func optionBoxDecodesNone() throws {
        let box = try WireCoding.decoder.decode(
            OptionBox<String>.self,
            from: Data(FixtureFrames.optionNone.utf8)
        )
        #expect(box.value == nil)
    }

    @Test("OptionBox encodes Some/None back to the tagged wire shape")
    func optionBoxEncodeRoundTrip() throws {
        let some = OptionBox<String>("origin/main")
        let someData = try WireCoding.encoder.encode(some)
        let someJSON = try WireCoding.decoder.decode(JSONValue.self, from: someData)
        #expect(someJSON["_tag"]?.stringValue == "Some")
        #expect(someJSON["value"]?.stringValue == "origin/main")

        let none = OptionBox<String>(nil)
        let noneData = try WireCoding.encoder.encode(none)
        let noneJSON = try WireCoding.decoder.decode(JSONValue.self, from: noneData)
        #expect(noneJSON["_tag"]?.stringValue == "None")
        #expect(noneJSON["value"] == nil)
    }

    // MARK: - `decode(_:forKey:default:)` (`withDecodingDefault`, §5.3)

    private struct DefaultedThread: Decodable, Equatable {
        let runtimeMode: String
        let proposedPlans: [String]

        init(runtimeMode: String, proposedPlans: [String]) {
            self.runtimeMode = runtimeMode
            self.proposedPlans = proposedPlans
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            self.runtimeMode = try container.decode(
                String.self, forKey: .runtimeMode, default: "full-access"
            )
            self.proposedPlans = try container.decode(
                [String].self, forKey: .proposedPlans, default: []
            )
        }

        private enum CodingKeys: String, CodingKey {
            case runtimeMode, proposedPlans
        }
    }

    @Test("decode(forKey:default:) supplies the default when the key is absent")
    func decodeWithDefaultOnAbsentKey() throws {
        let decoded = try WireCoding.decoder.decode(
            DefaultedThread.self, from: Data(#"{}"#.utf8)
        )
        #expect(decoded == DefaultedThread(runtimeMode: "full-access", proposedPlans: []))
    }

    @Test("decode(forKey:default:) uses the provided value when the key is present")
    func decodeWithDefaultOnPresentKey() throws {
        let decoded = try WireCoding.decoder.decode(
            DefaultedThread.self,
            from: Data(#"{"runtimeMode":"approval-required","proposedPlans":["p1"]}"#.utf8)
        )
        #expect(decoded == DefaultedThread(runtimeMode: "approval-required", proposedPlans: ["p1"]))
    }

    @Test("thread projections default an omitted runtimeMode")
    func threadProjectionsDefaultRuntimeMode() throws {
        let thread = try WireCoding.decoder.decode(
            OrchestrationThread.self,
            from: Data(FixtureFrames.orchestrationThreadWithoutRuntimeMode.utf8)
        )
        let shell = try WireCoding.decoder.decode(
            OrchestrationThreadShell.self,
            from: Data(FixtureFrames.orchestrationThreadShellWithoutRuntimeMode.utf8)
        )

        #expect(thread.runtimeMode == .wireDefault)
        #expect(shell.runtimeMode == .wireDefault)
    }

    // MARK: - §5.3/§5.4 no-value encoding matrix (absent key vs null vs Option)

    @Test("absent key, explicit null, and Option-None are three distinct wire shapes")
    func noValueEncodingMatrix() throws {
        // Schema.optional: the key is simply not present in the object.
        let absentKeyObject = try WireCoding.decoder.decode(
            JSONValue.self, from: Data(FixtureFrames.optionalKeyAbsent.utf8)
        )
        #expect(absentKeyObject.objectValue?["branch"] == nil)

        // Schema.NullOr: the key is present with a literal JSON null.
        let nullOrObject = try WireCoding.decoder.decode(
            JSONValue.self, from: Data(FixtureFrames.nullOrKeyPresentNull.utf8)
        )
        #expect(nullOrObject.objectValue?["branch"] == .some(.null))

        // Schema.Option: neither absent nor null — a tagged {_tag,value?} object.
        let optionNoneBox = try WireCoding.decoder.decode(
            OptionBox<String>.self, from: Data(FixtureFrames.optionNone.utf8)
        )
        #expect(optionNoneBox.value == nil)
        let optionSomeBox = try WireCoding.decoder.decode(
            OptionBox<String>.self, from: Data(FixtureFrames.optionSome.utf8)
        )
        #expect(optionSomeBox.value == "origin/main")
    }
}
