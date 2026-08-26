import QtQuick
import QtWebChannel
import QtWebEngine
import T3.Shell

// The web app, as-is. Wires the WebChannel (`window.t3Shell` on the page side)
// and pushes theme.json into the page as CSS custom properties.
WebEngineView {
    id: view

    backgroundColor: Theme.windowTransparent ? "transparent" : Theme.color("chrome", "#0b0b0d")

    // Persistent profile: the pairing session lives in cookies/localStorage.
    profile: persistentProfile.instance()

    WebEngineProfilePrototype {
        id: persistentProfile

        storageName: "t3code"
        persistentCookiesPolicy: WebEngineProfile.ForcePersistentCookies
    }

    webChannel: WebChannel {
        id: channel
    }

    Component.onCompleted: {
        channel.registerObject("shell", Shell);

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
}
