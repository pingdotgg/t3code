import QtQuick
import QtWebChannel
import QtWebEngine
import T3.Shell

// The web app, as-is. Wires the WebChannel (`window.t3Shell` on the page side)
// and pushes theme.json into the page as CSS custom properties: as a user
// script at document creation, so the first paint is already themed, and
// into the live document when the theme changes.
WebEngineView {
    id: view

    // Names this surface for the page (window.t3Shell.surfaceId), so menus it
    // opens come back to this view.
    property string surfaceId: "primary"

    // Freeze the page (no timers, no rendering) while the surface is hidden.
    // Its state stays in memory and it resumes where it was; a document that
    // must keep running out of view (the primary page) leaves this off.
    property bool sleepsWhenHidden: false

    // The source of the installed theme user script, to skip reinstalling on
    // theme signals that leave the page side unchanged.
    property string installedThemeScript: ""

    backgroundColor: Theme.windowTransparent ? "transparent" : Theme.color("chrome", "#0b0b0d")

    profile: WebProfile
    lifecycleState: sleepsWhenHidden && !visible && !loading ? WebEngineView.LifecycleState.Frozen : WebEngineView.LifecycleState.Active
    settings.javascriptCanAccessClipboard: true
    settings.javascriptCanPaste: true

    webChannel: WebChannel {
        id: channel
    }

    function syncThemeScript() {
        const source = Theme.loaded ? Theme.injectionScript : "";
        if (source === view.installedThemeScript) {
            return;
        }
        view.installedThemeScript = source;
        for (const stale of view.userScripts.find("t3-theme")) {
            view.userScripts.remove(stale);
        }
        if (source.length === 0) {
            return;
        }
        const script = WebEngine.script();
        script.name = "t3-theme";
        script.sourceCode = source;
        script.injectionPoint = WebEngineScript.DocumentCreation;
        script.worldId = WebEngineScript.MainWorld;
        view.userScripts.insert(script);
    }

    Component.onCompleted: {
        channel.registerObject("shell", Shell.channel);
        view.syncThemeScript();

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

    // The app's copy buttons and paste handlers use the async clipboard API.
    // Nothing else (notifications, media, location) is granted: the page has
    // no presenter for them here and falls back to its in-app affordances.
    onPermissionRequested: function (permission) {
        if (permission.permissionType === WebEnginePermission.PermissionType.ClipboardReadWrite) {
            permission.grant();
        } else {
            permission.deny();
        }
    }

    Connections {
        target: Theme
        function onThemeChanged() {
            view.syncThemeScript();
            if (!view.loading) {
                view.runJavaScript(Theme.injectionScript);
            }
        }
    }

    ContextMenuHost {
        surfaceId: view.surfaceId
    }
}
