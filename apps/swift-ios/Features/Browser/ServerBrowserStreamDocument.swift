import Foundation

struct ServerBrowserControl: Decodable, Equatable, Sendable {
    enum Controller: String, Decodable, Sendable { case agent, you, anotherViewer = "another-viewer", unclaimed }
    struct Dialog: Decodable, Equatable, Sendable {
        let type: String
        let message: String
        let defaultValue: String
    }
    let canOperate: Bool
    let controller: Controller
    let generation: Int
    var dialog: Dialog?
}

struct ServerBrowserHostSetup: Decodable, Equatable, Sendable {
    let need: String
    let command: String
}

enum ServerBrowserStreamStatus: String, Sendable { case connecting, streaming, error }

enum ServerBrowserStreamMessage: Equatable, Sendable {
    case control(ServerBrowserControl)
    case status(ServerBrowserStreamStatus, String?)
    case hostSetup(ServerBrowserHostSetup)
    case unauthorized, gone

    init?(data: String) {
        guard let bytes = data.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: bytes),
              case let .object(fields) = value,
              case let .string(type) = fields["type"] else { return nil }
        switch type {
        case "unauthorized": self = .unauthorized
        case "gone": self = .gone
        case "control":
            guard let control = try? JSONDecoder().decode(ServerBrowserControl.self, from: bytes) else { return nil }
            self = .control(control)
        case "hostSetup":
            guard let setup = try? JSONDecoder().decode(ServerBrowserHostSetup.self, from: bytes),
                  ["sandbox", "libraries"].contains(setup.need), !setup.command.isEmpty else { return nil }
            self = .hostSetup(setup)
        case "status":
            guard case let .string(raw) = fields["status"], let status = ServerBrowserStreamStatus(rawValue: raw) else { return nil }
            if let detail = fields["detail"] {
                guard case let .string(text) = detail else { return nil }
                self = .status(status, text)
            } else { self = .status(status, nil) }
        default: return nil
        }
    }
}

struct ServerBrowserStreamState: Equatable {
    private(set) var streaming = false
    private(set) var control: ServerBrowserControl?
    private(set) var error: String?
    private(set) var hostSetup: ServerBrowserHostSetup?
    private(set) var gone = false
    var ready: Bool { streaming && error == nil && control?.canOperate == true && control?.controller == .you }
    var canTakeControl: Bool { streaming && error == nil && control?.canOperate == true && control?.controller != .you }

    mutating func suspend() { streaming = false; control = nil }

    mutating func receive(_ message: ServerBrowserStreamMessage) {
        guard error == nil, hostSetup == nil, !gone else { return }
        switch message {
        case let .control(value): control = value
        case let .status(status, detail):
            streaming = status == .streaming
            if status == .connecting { control = nil }
            if status == .error { error = detail ?? "Browser stream failed."; suspend() }
        case let .hostSetup(setup):
            hostSetup = setup
            error = "The server browser needs setup. Run this command on its host."
            suspend()
        case .gone: gone = true; suspend()
        case .unauthorized: suspend()
        }
    }

    func permits(_ command: ServerBrowserStreamCommand) -> Bool {
        if case .takeControl = command { return canTakeControl }
        return ready
    }
}

enum ServerBrowserStreamCommand {
    case takeControl, releaseControl, reload
    case navigate(String), history(Int), dialog(accept: Bool, text: String)

    var javaScript: String {
        var fields: [String: JSONValue]
        switch self {
        case .takeControl: fields = ["type": .string("takeControl")]
        case .releaseControl: fields = ["type": .string("releaseControl")]
        case .reload: fields = ["type": .string("reload")]
        case let .navigate(url): fields = ["type": .string("navigate"), "url": .string(url)]
        case let .history(delta): fields = ["type": .string("history"), "delta": .number(Double(delta))]
        case let .dialog(accept, text):
            fields = ["type": .string("dialog"), "accept": .bool(accept), "promptText": .string(text)]
        }
        guard let data = try? JSONEncoder().encode(JSONValue.object(fields)) else { return "void 0;" }
        return "window.T3BrowserStream?.command(\(String(decoding: data, as: UTF8.self))); true;"
    }
}

enum ServerBrowserStreamDocument {
    private struct Configuration: Encodable {
        let access: ServerBrowserAccess
        let threadId: String
        let tabId: String
        let interactive: Bool
        let background = "#000000"
    }

    static func html(connection: FeatureServerBrowserConnection, script: String) throws -> String {
        let config = Configuration(access: connection.access, threadId: connection.threadID,
                                   tabId: connection.tabID, interactive: connection.interactive)
        let json = String(decoding: try JSONEncoder().encode(config), as: UTF8.self)
            .replacingOccurrences(of: "<", with: "\\u003c")
        let safeScript = script.replacingOccurrences(of: "</script", with: "<\\/script", options: .caseInsensitive)
        return """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"></head>
        <body style="margin:0;background:#000"><script>
        window.ReactNativeWebView = {postMessage: function(message) { window.webkit.messageHandlers.browserStream.postMessage(message); }};
        const failed = function() { window.ReactNativeWebView.postMessage(JSON.stringify({type:'status',status:'error',detail:'Browser viewer stopped unexpectedly.'})); };
        window.addEventListener('error', failed); window.addEventListener('unhandledrejection', failed);
        \(safeScript)
        try { T3BrowserStream.start(\(json)); } catch { failed(); }
        </script></body></html>
        """
    }
}
