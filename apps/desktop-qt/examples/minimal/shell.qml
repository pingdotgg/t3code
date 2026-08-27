import QtQuick
import QtQuick.Layouts
import T3.Shell
import T3.Bricks

// Copy to ~/.t3/shell/shell.qml and edit; the app reloads on save.
// Bricks come from T3.Bricks, data from the T3.Shell singletons
// (Shell.state, Shell.dispatch, Theme.*, Runtime.*).
Window {
    id: root

    readonly property bool sidebarCollapsed: Shell.state.layout ? Shell.state.layout.sidebarCollapsed : false

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
                Layout.preferredWidth: root.sidebarCollapsed ? 0 : 260
                visible: (!settingsNav.active) && (!root.sidebarCollapsed || width > 0)
                Layout.minimumWidth: 0

                Behavior on Layout.preferredWidth {
                    NumberAnimation {
                        duration: 220
                        easing.type: Easing.OutCubic
                    }
                }
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

                    sidebarToggle: root.sidebarCollapsed
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
        anchors.bottom: parent.bottom
        anchors.right: parent.right
        anchors.bottomMargin: 180
        anchors.rightMargin: 16
    }

    ContextMenuHost {
        surfaceId: "shell"
    }

    ShellErrorOverlay {
        anchors.fill: parent
    }
}
