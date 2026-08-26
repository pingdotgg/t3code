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

        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 0

            Sidebar {
                Layout.fillHeight: true
                Layout.preferredWidth: 260
                visible: !settingsNav.active
            }

            SettingsNav {
                id: settingsNav

                Layout.fillHeight: true
                Layout.preferredWidth: 260
                visible: active
            }

            ColumnLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: 0

                Workspace {
                    Layout.fillWidth: true
                    visible: ready
                }

                WebSurface {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    url: Shell.pageUrl
                }

                Composer {
                    Layout.fillWidth: true
                    visible: ready
                }
            }

            RightPanel {
                Layout.fillHeight: true
                Layout.preferredWidth: implicitWidth
                visible: available
            }
        }

        // Title bar at the bottom instead of the top.
        TitleBar {
            Layout.fillWidth: true
            visible: Theme.frameless
            window: root
        }
    }

    Notifications {
        anchors.top: parent.top
        anchors.right: parent.right
        anchors.topMargin: 96
        anchors.rightMargin: 16
    }

    ShellErrorOverlay {
        anchors.fill: parent
    }
}
