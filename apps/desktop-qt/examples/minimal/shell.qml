import QtQuick
import QtQuick.Layouts
import T3.Shell
import T3.Bricks

// Copy to ~/.t3/shell/shell.qml and edit; the app reloads on save.
// Bricks come from T3.Bricks, data from the T3.Shell singletons
// (Shell.state, Shell.dispatch, Theme.*, Runtime.*). ShellWindow brings the
// window boilerplate, the error overlay and the page's window commands.
ShellWindow {
    id: root

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 0

            Sidebar {
                Layout.fillHeight: true
                Layout.preferredWidth: root.sidebarCollapsed ? 0 : 256
                Layout.minimumWidth: 0
                visible: !root.settingsActive && (!root.sidebarCollapsed || width > 0)
                showBrand: true
                window: root

                Behavior on Layout.preferredWidth {
                    NumberAnimation {
                        duration: 220
                        easing.type: Easing.OutCubic
                    }
                }
            }

            SettingsNav {
                Layout.fillHeight: true
                Layout.preferredWidth: 256
                visible: root.settingsActive
            }

            ColumnLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: 0

                Workspace {
                    Layout.fillWidth: true
                    visible: ready
                    sidebarToggle: root.sidebarCollapsed
                    panelToggle: rightPanel.available ? rightPanel.open : null
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

                TerminalDrawer {
                    Layout.fillWidth: true
                }
            }

            RightPanel {
                id: rightPanel

                Layout.fillHeight: true
                Layout.preferredWidth: implicitWidth
                ownToggle: false
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
}
