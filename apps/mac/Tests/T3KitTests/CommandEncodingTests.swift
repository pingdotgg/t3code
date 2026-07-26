// CommandEncodingTests.swift
// Null-vs-omitted key semantics for partial meta-update commands: fields
// declared `Schema.optional(Schema.NullOr(x))` in the contract distinguish
// "leave untouched" (key omitted) from "clear" (explicit null), so the Swift
// wrappers use nested optionals and manual encode(to:).

import Testing
@testable import T3Kit
import Foundation

@Suite("ProjectMetaUpdateCommand encoding")
struct ProjectMetaUpdateCommandEncodingTests {

    private func encodeToJSON(_ command: ProjectMetaUpdateCommand) throws -> JSONValue {
        let data = try WireCoding.encoder.encode(command)
        return try WireCoding.decoder.decode(JSONValue.self, from: data)
    }

    @Test("default nil omits defaultModelSelection (leave untouched)")
    func omitsWhenNil() throws {
        let value = try encodeToJSON(
            ProjectMetaUpdateCommand(commandId: "cmd_1", projectId: "prj_1", title: "Renamed"))
        #expect(value["defaultModelSelection"] == nil)
        #expect(value["title"]?.stringValue == "Renamed")
        #expect(value["type"]?.stringValue == "project.meta.update")
    }

    @Test(".some(nil) sends explicit null (clear the project default)")
    func explicitNullClears() throws {
        let value = try encodeToJSON(
            ProjectMetaUpdateCommand(
                commandId: "cmd_1", projectId: "prj_1", defaultModelSelection: .some(nil)))
        #expect(value["defaultModelSelection"] == .null)
    }

    @Test(".some(value) sends the selection")
    func valueSets() throws {
        let selection = ModelSelection(instanceId: "anthropic", model: "claude-fable-5")
        let value = try encodeToJSON(
            ProjectMetaUpdateCommand(
                commandId: "cmd_1", projectId: "prj_1", defaultModelSelection: selection))
        #expect(value["defaultModelSelection"]?["model"]?.stringValue == "claude-fable-5")
    }
}

@Suite("ThreadExecutorModelSetCommand encoding")
struct ThreadExecutorModelSetCommandEncodingTests {

    private func encodeToJSON(_ command: ThreadExecutorModelSetCommand) throws -> JSONValue {
        let data = try WireCoding.encoder.encode(command)
        return try WireCoding.decoder.decode(JSONValue.self, from: data)
    }

    @Test("nil selection encodes explicit null (clear the executor)")
    func explicitNullClears() throws {
        let value = try encodeToJSON(
            ThreadExecutorModelSetCommand(
                commandId: "cmd_1", threadId: "thr_1", executorModelSelection: nil,
                createdAt: "2026-01-01T00:00:00Z"))
        #expect(value["type"]?.stringValue == "thread.executor-model.set")
        #expect(value["executorModelSelection"] == .null)
    }

    @Test("nil executorMaxSubAgents omits the key (leave untouched)")
    func omitsMaxSubAgentsWhenNil() throws {
        let value = try encodeToJSON(
            ThreadExecutorModelSetCommand(
                commandId: "cmd_1", threadId: "thr_1", executorModelSelection: nil,
                createdAt: "2026-01-01T00:00:00Z"))
        #expect(value["executorMaxSubAgents"] == nil)
    }

    @Test("set executorMaxSubAgents is encoded")
    func encodesMaxSubAgentsWhenSet() throws {
        let selection = ModelSelection(instanceId: "codex", model: "gpt-5-codex")
        let value = try encodeToJSON(
            ThreadExecutorModelSetCommand(
                commandId: "cmd_1", threadId: "thr_1", executorModelSelection: selection,
                executorMaxSubAgents: 7, createdAt: "2026-01-01T00:00:00Z"))
        #expect(value["executorMaxSubAgents"] == .int(7))
        #expect(value["executorModelSelection"]?["model"]?.stringValue == "gpt-5-codex")
    }
}
