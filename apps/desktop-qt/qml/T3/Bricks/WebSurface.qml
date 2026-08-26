import QtQuick
import QtWebChannel
import QtWebEngine
import T3.Shell

// The web app, as-is. Wires the WebChannel (`window.t3Shell` on the page side)
// and pushes theme.json into the page as CSS custom properties.
WebEngineView {
    id: view

    // Names this surface for the page (window.t3Shell.surfaceId), so menus it
    // opens come back to this view.
    property string surfaceId: "primary"

    backgroundColor: Theme.windowTransparent ? "transparent" : Theme.color("chrome", "#0b0b0d")

    profile: WebProfile.instance

    webChannel: WebChannel {
        id: channel
    }

    Component.onCompleted: {
        channel.registerObject("shell", Shell);

        const tag = WebEngine.script();
        tag.name = "t3-surface-id";
        tag.sourceCode = "window.__t3ShellSurfaceId = " + JSON.stringify(view.surfaceId) + ";";
        tag.injectionPoint = WebEngineScript.DocumentCreation;
        tag.worldId = WebEngineScript.MainWorld;
        view.userScripts.insert(tag);

        const transport = WebEngine.script();
        transport.name = "t3-webchannel";
        transport.sourceUrl = Shell.webChannelScriptUrl;
        transport.injectionPoint = WebEngineScript.DocumentCreation;
        transport.worldId = WebEngineScript.MainWorld;
        view.userScripts.insert(transport);

        const connector = WebEngine.script();
        connector.name = "t3-shell-connect";
        connector.sourceUrl = "qrc:/qt/qml/T3/Bricks/js/shell-connect.js";
        connector.injectionPoint = WebEngineScript.DocumentCreation;
        connector.worldId = WebEngineScript.MainWorld;
        view.userScripts.insert(connector);
    }

    onLoadingChanged: function (info) {
        if (info.status === WebEngineView.LoadStartedStatus) {
            return;
        }
        const ok = info.status === WebEngineView.LoadSucceededStatus;
        console.info("[web]", ok ? "loaded" : "load failed", info.url, ok ? "" : info.errorString);
        if (ok) {
            view.runJavaScript(Theme.injectionScript);
        }
        Shell.notifyPageLoaded(ok, info.url);
    }

    onNewWindowRequested: function (request) {
        Shell.openExternal(request.requestedUrl);
    }

    Connections {
        target: Theme
        function onThemeChanged() {
            if (!view.loading) {
                view.runJavaScript(Theme.injectionScript);
            }
        }
    }

    ContextMenuHost {
        surfaceId: view.surfaceId
    }
}
