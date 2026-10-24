import Foundation

enum RemoteDeviceStreamStatus: String, Sendable {
    case connecting, streaming, error
}

enum RemoteDeviceStreamMessage: Equatable, Sendable {
    case input(Bool)
    case status(RemoteDeviceStreamStatus, String?)
    case unauthorized
    case retry

    init?(data: String) {
        guard let bytes = data.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: bytes),
              case let .object(fields) = value,
              case let .string(type) = fields["type"] else { return nil }
        switch type {
        case "unauthorized": self = .unauthorized
        case "retry": self = .retry
        case "input":
            guard case let .bool(connected) = fields["connected"] else { return nil }
            self = .input(connected)
        case "status":
            guard case let .string(rawStatus) = fields["status"],
                  let status = RemoteDeviceStreamStatus(rawValue: rawStatus) else { return nil }
            let detail: String?
            if let rawDetail = fields["detail"] {
                guard case let .string(text) = rawDetail else { return nil }
                detail = text
            } else { detail = nil }
            self = .status(status, detail)
        default: return nil
        }
    }
}

enum RemoteDeviceStreamCommand: String {
    case home, back, appSwitcher, rotate

    var javaScript: String { "window.T3DeviceStream?.command('\(rawValue)'); true;" }
}

enum RemoteDeviceStreamDocument {
    private struct Configuration: Encodable {
        let access: RemoteDeviceHubAccess
        let platform: RemoteDevicePlatform
        let deviceId: String
        let colors = [
            "background": "#000000", "foreground": "#ffffff", "muted": "#a3a3a3",
            "buttonBackground": "#000000", "buttonForeground": "#ffffff", "buttonBorder": "#444444",
        ]
    }

    static func html(connection: FeatureRemoteDeviceConnection, script: String) throws -> String {
        let configuration = Configuration(
            access: connection.access, platform: connection.preview.session.platform,
            deviceId: connection.preview.id.deviceID
        )
        let data = try JSONEncoder().encode(configuration)
        // Server labels and tickets are data, even if they contain HTML delimiters.
        let json = String(decoding: data, as: UTF8.self).replacingOccurrences(of: "<", with: "\\u003c")
        let safeScript = script.replacingOccurrences(of: "</script", with: "<\\/script", options: .caseInsensitive)
        return """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"></head>
        <body style="margin:0;background:#000"><script>
        window.ReactNativeWebView = {postMessage: function(message) { window.webkit.messageHandlers.deviceStream.postMessage(message); }};
        const failed = function() { window.ReactNativeWebView.postMessage(JSON.stringify({type:'status',status:'error',detail:'Device viewer stopped unexpectedly.'})); };
        window.addEventListener('error', failed);
        window.addEventListener('unhandledrejection', failed);
        \(safeScript)
        try { T3DeviceStream.start(\(json)); } catch { failed(); }
        </script></body></html>
        """
    }
}
