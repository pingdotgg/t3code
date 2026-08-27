import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import T3.Shell
import T3.Bricks

// Phosphor: a status bar on top (clock, thread counts, model), a narrow
// sidebar, sharp corners and mono type everywhere — a terminal rice.
Window {
    id: root

    readonly property bool sidebarCollapsed: Shell.state.layout ? Shell.state.layout.sidebarCollapsed : false

    property date now: new Date()

    readonly property bool settingsActive: Shell.state.settings ? Shell.state.settings.active : false
    readonly property var sidebarState: Shell.state.sidebar ?? null
    readonly property var composerState: Shell.state.composer ?? null
    readonly property color ink: Theme.color("text", "#c8f0d0")
    readonly property color dim: Theme.color("textMuted", "#6f9a7a")
    readonly property color glow: Theme.color("accent", "#3ddc84")
    readonly property string mono: Theme.fontMono.length > 0 ? Theme.fontMono : "Menlo"

    width: 1360
    height: 860
    visible: true
    title: qsTr("T3 Code")
    color: Theme.color("canvas", "#0b0f0c")
    opacity: Theme.windowOpacity
    flags: Qt.Window | Qt.FramelessWindowHint

    Timer {
        interval: 1000
        running: true
        repeat: true
        onTriggered: root.now = new Date()
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // Status bar.
        Rectangle {
            Layout.fillWidth: true
            implicitHeight: 30
            color: Theme.color("chrome", "#080b09")

            DragHandler {
                target: null
                onActiveChanged: if (active)
                    root.startSystemMove()
            }

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 12
                anchors.rightMargin: 8
                spacing: 18

                Text {
                    text: "t3code"
                    color: root.glow
                    font.family: root.mono
                    font.pixelSize: 12
                    font.bold: true
                }

                Text {
                    text: root.sidebarState ? qsTr("active %1 · settled %2").arg(root.sidebarState.active.length + root.sidebarState.pinned.length).arg(root.sidebarState.settledTotal) : ""
                    color: root.dim
                    font.family: root.mono
                    font.pixelSize: 12
                }

                Text {
                    text: root.composerState && root.composerState.selectedModel ? root.composerState.selectedModel : ""
                    color: root.dim
                    font.family: root.mono
                    font.pixelSize: 12
                }

                Item {
                    Layout.fillWidth: true
                }

                Text {
                    text: Qt.formatDateTime(root.now, "ddd dd MMM  HH:mm:ss")
                    color: root.ink
                    font.family: root.mono
                    font.pixelSize: 12
                }

                TitleBar {
                    Layout.preferredWidth: 110
                    Layout.preferredHeight: 30
                    window: root
                    color: "transparent"
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: 1
            color: Theme.color("border", "#22372a")
        }

        Workspace {
            Layout.fillWidth: true
            visible: ready
            sidebarToggle: root.sidebarCollapsed
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 0

            Sidebar {
                Layout.preferredWidth: root.sidebarCollapsed ? 0 : 240
                Layout.minimumWidth: 0
                Layout.fillHeight: true
                visible: !root.settingsActive && (!root.sidebarCollapsed || width > 0)

                Behavior on Layout.preferredWidth {
                    NumberAnimation {
                        duration: 220
                        easing.type: Easing.OutCubic
                    }
                }
            }

            SettingsNav {
                Layout.preferredWidth: 240
                Layout.fillHeight: true
                visible: root.settingsActive
            }

            Rectangle {
                Layout.preferredWidth: 1
                Layout.fillHeight: true
                color: Theme.color("border", "#22372a")
            }

            ColumnLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: 0

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
