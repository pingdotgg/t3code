import Foundation
import Testing
@testable import T3Code

@Suite("Server browser native bridge")
struct ServerBrowserStreamTests {
    @Test func observeAndControlAreSeparateGrants() {
        var state = ServerBrowserStreamState()
        state.receive(.status(.streaming, nil))
        state.receive(.control(.init(canOperate: false, controller: .you, generation: 1)))
        #expect(!state.permits(.takeControl))
        #expect(!state.permits(.navigate("https://example.com")))
        state.receive(.control(.init(canOperate: true, controller: .agent, generation: 2)))
        #expect(state.permits(.takeControl))
        #expect(!state.permits(.reload))
        state.receive(.control(.init(canOperate: true, controller: .you, generation: 3)))
        #expect(state.permits(.history(-1)))
        #expect(state.permits(.releaseControl))
        state.receive(.status(.connecting, nil))
        #expect(!state.permits(.reload))
        #expect(state.control == nil)
    }

    @Test func hostSetupRemainsTerminalAcrossLateFramesAndBackgrounding() throws {
        let message = try #require(ServerBrowserStreamMessage(data: #"{"type":"hostSetup","need":"libraries","command":"sudo npx t3 browser setup"}"#))
        var state = ServerBrowserStreamState()
        state.receive(message)
        state.receive(.status(.streaming, nil))
        state.suspend()
        #expect(state.hostSetup?.command == "sudo npx t3 browser setup")
        #expect(!state.streaming)
        #expect(!state.permits(.takeControl))
        #expect(state.error != nil)
    }

    @Test func bridgeRejectsMalformedControlAndStatus() {
        #expect(ServerBrowserStreamMessage(data: #"{"type":"control","canOperate":true,"controller":"you","generation":1,"dialog":null}"#) != nil)
        #expect(ServerBrowserStreamMessage(data: #"{"type":"control","canOperate":"true","controller":"you","generation":1}"#) == nil)
        #expect(ServerBrowserStreamMessage(data: #"{"type":"status","status":"error","detail":42}"#) == nil)
        #expect(ServerBrowserStreamMessage(data: #"{"type":"hostSetup","need":"other","command":"x"}"#) == nil)
    }

    @Test func ticketsAndTabIDsCannotEscapeTheDocument() throws {
        let connection = FeatureServerBrowserConnection(
            environmentID: "one", threadID: "thread", tabID: "</script><script>unexpected()",
            access: try .ticketed(environmentURL: URL(string: "https://relay.example")!, ticket: "</script>ticket"),
            interactive: false
        )
        let html = try ServerBrowserStreamDocument.html(connection: connection, script: "window.T3BrowserStream={start(){}};")
        #expect(!html.contains("<script>unexpected()"))
        #expect(html.components(separatedBy: "</script>").count == 2)
        #expect(html.contains("\\u003c"))
        #expect(html.contains("\"interactive\":false"))
    }

    @Test func navigationCommandsEncodeInputAsData() throws {
        let url = "https://example.com/?q=\";unexpected();//"
        let script = ServerBrowserStreamCommand.navigate(url).javaScript
        let prefix = "window.T3BrowserStream?.command("
        let payload = String(script.dropFirst(prefix.count).dropLast("); true;".count))
        let json = try JSONDecoder().decode(JSONValue.self, from: Data(payload.utf8))
        #expect(json["url"] == .string(url))
    }
}
