import QtQuick
import QtQuick.Layouts
import T3.Shell
import T3.Bricks

// Terminal: a status line on top (prompt mark, thread counts, model, the
// palette's sixteen colours, clock), a narrow sidebar, sharp corners and mono
// type everywhere. theme-from-terminal.mjs next to this file writes a
// theme.json in the colours of whatever terminal you run it from.
ShellWindow {
    id: root

    readonly property var sidebarState: Shell.state.sidebar ?? null
    readonly property var composerState: Shell.state.composer ?? null
    readonly property color ink: Theme.color("text", "#c8f0d0")
    readonly property color dim: Theme.color("textMuted", "#6f9a7a")
    readonly property color glow: Theme.color("accent", "#3ddc84")
    readonly property color line: Theme.color("border", "#22372a")
    // The ANSI slots land in the theme when it came from a terminal; a hand-
    // written theme shows its semantic colours in the same strip instead.
    readonly property var swatches: [Theme.color("ansiBlack", Theme.color("surfaceRaised", "#182319")), Theme.color("ansiRed", Theme.color("error", "#ff6b6b")), Theme.color("ansiGreen", Theme.color("update", "#3ddc84")), Theme.color("ansiYellow", Theme.color("warning", "#ffd166")), Theme.color("ansiBlue", Theme.color("accent", "#3ddc84")), Theme.color("ansiMagenta", Theme.color("accentSurface", "#163a25")), Theme.color("ansiCyan", Theme.color("info", "#3ddc84")), Theme.color("ansiWhite", Theme.color("text", "#c8f0d0"))]

    property date now: new Date()

    width: 1360
    height: 860

    Timer {
        interval: 1000
        running: root.visible
        repeat: true
        onTriggered: root.now = new Date()
    }

    component Segment: Text {
        color: root.dim
        font.family: Theme.fontMono
        font.pixelSize: 12
    }

    component Divider: Text {
        text: "│"
        color: root.line
        font.family: Theme.fontMono
        font.pixelSize: 12
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // Status line.
        Item {
            Layout.fillWidth: true
            Layout.preferredHeight: 30

            DragHandler {
                target: null
                onActiveChanged: if (active)
                    root.startSystemMove()
            }

            TapHandler {
                onDoubleTapped: root.visibility === Window.Maximized ? root.showNormal() : root.showMaximized()
            }

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 12
                spacing: 10

                Segment {
                    text: "❯"
                    color: root.glow
                    font.bold: true
                }

                Segment {
                    text: "t3code"
                    color: root.ink
                    font.bold: true
                }

                Divider {
                }

                Segment {
                    text: root.sidebarState ? qsTr("%1 active").arg(root.sidebarState.active.length + root.sidebarState.pinned.length) : qsTr("connecting")
                }

                Segment {
                    visible: root.sidebarState !== null
                    text: root.sidebarState ? qsTr("%1 settled").arg(root.sidebarState.settledTotal) : ""
                }

                Divider {
                    visible: modelSegment.visible
                }

                Segment {
                    id: modelSegment

                    visible: text.length > 0
                    text: root.composerState && root.composerState.selectedModel ? root.composerState.selectedModel : ""
                }

                Item {
                    Layout.fillWidth: true
                }

                Row {
                    Layout.alignment: Qt.AlignVCenter
                    spacing: 3

                    Repeater {
                        model: root.swatches

                        Rectangle {
                            required property color modelData

                            width: 8
                            height: 8
                            color: modelData
                        }
                    }
                }

                Divider {
                }

                Segment {
                    text: Qt.formatDateTime(root.now, "ddd dd MMM  HH:mm:ss")
                    color: root.ink
                }

                WindowControls {
                    Layout.alignment: Qt.AlignVCenter
                    window: root
                    buttonWidth: 34
                    buttonHeight: 26
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 1
            color: root.line
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            color: Theme.color("canvas", "#0b0f0c")

            RowLayout {
                anchors.fill: parent
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
                    color: root.line
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
                }

                RightPanel {
                    id: rightPanel

                    Layout.fillHeight: true
                    Layout.preferredWidth: implicitWidth
                    ownToggle: false
                    visible: available
                }
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
