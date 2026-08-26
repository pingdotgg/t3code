import QtQuick
import QtQuick.Layouts
import T3.Shell
import T3.Bricks

// Copy to ~/.config/t3code/shell.qml and edit; the app reloads on save.
// Bricks come from T3.Bricks, data from the T3.Shell singletons
// (Shell.state, Shell.dispatch, Theme.*, Runtime.*).
Window {
    id: root

    width: 1280
    height: 820
    visible: true
    title: qsTr("T3 Code")
    color: Theme.windowTransparent ? "transparent" : Theme.color("chrome", "#0b0b0d")
    opacity: Theme.windowOpacity
    flags: Theme.frameless ? Qt.Window | Qt.FramelessWindowHint : Qt.Window

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        WebSurface {
            Layout.fillWidth: true
            Layout.fillHeight: true
            url: Shell.pageUrl
        }

        // Title bar at the bottom instead of the top.
        TitleBar {
            Layout.fillWidth: true
            visible: Theme.frameless
            window: root
        }
    }

    ShellErrorOverlay {
        anchors.fill: parent
    }
}
