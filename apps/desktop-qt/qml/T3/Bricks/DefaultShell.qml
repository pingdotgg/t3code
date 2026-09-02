import QtQuick
import QtQuick.Layouts
import T3.Shell
import T3.Bricks

// Built-in layout, laid out like the page's own chrome: sidebar, header
// strip, timeline, composer. A user's ~/.t3/shell/shell.qml replaces this
// file wholesale; it is also the fallback when that file fails to load.
// Frameless windows get their drag handle and window buttons from the
// sidebar band and the header strip rather than a separate title bar.
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
                id: sidebar

                Layout.fillHeight: true
                // Not animated: see RightPanel.
                Layout.preferredWidth: root.sidebarCollapsed ? 0 : 256
                Layout.minimumWidth: 0
                visible: !root.settingsActive && !root.sidebarCollapsed
                showBrand: true
                window: root
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
                    window: root
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
                ownToggle: false
                Layout.preferredWidth: implicitWidth
                visible: available
            }
        }
    }

    Notifications {
        anchors.bottom: parent.bottom
        anchors.right: parent.right
        anchors.bottomMargin: 180
        anchors.rightMargin: 16
    }
}
