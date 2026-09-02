import QtQuick
import T3.Shell

// The window every rice starts from: theme-driven colour, opacity and frame,
// the shell's own context menus and error overlay, and the page's window
// commands (minimize / maximize / close / move). Children land in the body
// under the overlay, so a broken layout still shows its error.
Window {
    id: root

    default property alias content: body.data

    // The page owns both of these (Mod+B collapses, Settings opens); the shell
    // only animates and re-arranges around them.
    readonly property bool sidebarCollapsed: Shell.state.layout ? Shell.state.layout.sidebarCollapsed : false
    readonly property bool settingsActive: Shell.state.settings ? Shell.state.settings.active : false
    // The page's keybindings (the configurable ones from Settings), as Qt
    // sequences. They fire only while the chrome owns the keyboard: a
    // focused page sees its own keydowns and handles them itself.
    readonly property var keybindings: Shell.state.keybindings ?? []
    readonly property bool webFocused: isWebItem(root.activeFocusItem)

    function isWebItem(item) {
        for (let node = item; node; node = node.parent) {
            if (node.objectName === "T3WebSurface") {
                return true;
            }
        }
        return false;
    }

    width: 1280
    height: 820
    minimumWidth: 640
    minimumHeight: 400
    visible: true
    title: qsTr("T3 Code")
    color: Theme.windowTransparent ? "transparent" : Theme.color("chrome", "#0b0b0d")
    opacity: Theme.windowOpacity
    flags: Theme.frameless ? Qt.Window | Qt.FramelessWindowHint : Qt.Window

    Item {
        id: body

        anchors.fill: parent
    }

    ContextMenuHost {
        surfaceId: "shell"
    }

    ShellErrorOverlay {
        anchors.fill: parent
    }

    Instantiator {
        model: root.keybindings

        delegate: Shortcut {
            required property var modelData

            sequence: modelData.sequence
            context: Qt.WindowShortcut
            enabled: !root.webFocused
            onActivated: Shell.dispatch("keybinding.press", {
                key: modelData.key,
                ctrlKey: modelData.ctrlKey,
                metaKey: modelData.metaKey,
                shiftKey: modelData.shiftKey,
                altKey: modelData.altKey
            })
        }
    }

    Connections {
        target: Shell
        function onWindowCommandRequested(command) {
            switch (command) {
            case "minimize":
                root.showMinimized();
                break;
            case "maximize":
                root.visibility === Window.Maximized ? root.showNormal() : root.showMaximized();
                break;
            case "close":
                root.close();
                break;
            case "move":
                root.startSystemMove();
                break;
            }
        }
    }
}
