import QtQuick
import QtQuick.Layouts
import T3.Shell
import T3.Bricks

// Terminal: a powerline status line on top (session, model and clock as
// solid blocks in the palette's colours, prompt mark, thread counts, the
// sixteen ANSI slots as a chip), the sidebar on the darker chrome, sharp
// corners and mono type everywhere. `vp run theme:qt` writes
// a theme.json in the colours of whatever terminal you run it from; the one
// next to this file is Tokyo Night through that generator.
ShellWindow {
    id: root

    readonly property var sidebarState: Shell.state.sidebar ?? null
    readonly property var composerState: Shell.state.composer ?? null
    readonly property color canvas: Theme.color("canvas", "#1a1b26")
    readonly property color chrome: Theme.color("chrome", "#14151e")
    readonly property color ink: Theme.color("text", "#c0caf5")
    readonly property color dim: Theme.color("secondaryLabel", "#a9b1d6")
    readonly property color line: Theme.color("border", "#3d4461")
    // The ANSI slots land in the theme when it came from a terminal; a hand-
    // written theme falls back to its semantic colours.
    readonly property color blue: Theme.color("ansiBlue", Theme.color("accent", "#7aa2f7"))
    readonly property color cyan: Theme.color("ansiCyan", Theme.color("info", "#7dcfff"))
    readonly property color green: Theme.color("ansiGreen", Theme.color("update", "#9ece6a"))
    readonly property color yellow: Theme.color("ansiYellow", Theme.color("warning", "#e0af68"))
    readonly property color magenta: Theme.color("ansiMagenta", Theme.color("accent", "#bb9af7"))
    readonly property var swatches: [Theme.color("ansiBlack", Theme.color("surfaceRaised", "#2e3247")), Theme.color("ansiRed", Theme.color("error", "#f7768e")), Theme.color("ansiGreen", Theme.color("update", "#9ece6a")), Theme.color("ansiYellow", Theme.color("warning", "#e0af68")), Theme.color("ansiBlue", Theme.color("accent", "#7aa2f7")), Theme.color("ansiMagenta", Theme.color("accentSurface", "#374465")), Theme.color("ansiCyan", Theme.color("info", "#7dcfff")), Theme.color("ansiWhite", Theme.color("textMuted", "#757b98")), Theme.color("ansiBrightBlack", Theme.color("border", "#31364e")), Theme.color("ansiBrightRed", Theme.color("errorForeground", "#f7768e")), Theme.color("ansiBrightGreen", Theme.color("updateForeground", "#9ece6a")), Theme.color("ansiBrightYellow", Theme.color("warningForeground", "#e0af68")), Theme.color("ansiBrightBlue", Theme.color("focus", "#7aa2f7")), Theme.color("ansiBrightMagenta", Theme.color("accent", "#bb9af7")), Theme.color("ansiBrightCyan", Theme.color("info", "#7dcfff")), Theme.color("ansiBrightWhite", Theme.color("text", "#c0caf5"))]

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
        verticalAlignment: Text.AlignVCenter
        Layout.fillHeight: true
    }

    // A solid powerline block: palette colour behind bold canvas-coloured text.
    component Block: Rectangle {
        property alias text: label.text

        Layout.fillHeight: true
        Layout.preferredWidth: label.implicitWidth + 24
        color: root.blue

        Segment {
            id: label

            anchors.fill: parent
            horizontalAlignment: Text.AlignHCenter
            color: root.chrome
            font.bold: true
        }
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // Status line: chrome-dark, with the session, model and clock as
        // solid blocks in the palette's blue, magenta and yellow.
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 34
            color: root.chrome

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
                spacing: 0

                Block {
                    text: "t3code"
                }

                Segment {
                    Layout.leftMargin: 14
                    text: "❯"
                    color: root.green
                    font.bold: true
                }

                Segment {
                    Layout.leftMargin: 10
                    color: root.cyan
                    text: root.sidebarState ? qsTr("%1 active").arg(root.sidebarState.active.length + root.sidebarState.pinned.length) : qsTr("connecting")
                }

                Segment {
                    Layout.leftMargin: 10
                    visible: root.sidebarState !== null
                    text: root.sidebarState ? qsTr("%1 settled").arg(root.sidebarState.settledTotal) : ""
                }

                Block {
                    Layout.leftMargin: 14
                    visible: text.length > 0
                    color: root.magenta
                    text: root.composerState && root.composerState.selectedModel ? root.composerState.selectedModel : ""
                }

                Item {
                    Layout.fillWidth: true
                }

                // The sixteen slots as a chip: normal row over bright row.
                Grid {
                    Layout.alignment: Qt.AlignVCenter
                    Layout.rightMargin: 14
                    columns: 8
                    spacing: 2

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

                Segment {
                    Layout.rightMargin: 14
                    text: Qt.formatDateTime(root.now, "ddd dd MMM")
                }

                Block {
                    color: root.yellow
                    text: Qt.formatDateTime(root.now, "HH:mm:ss")
                }

                WindowControls {
                    Layout.alignment: Qt.AlignVCenter
                    Layout.leftMargin: 6
                    window: root
                    buttonWidth: 32
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
            color: root.canvas

            RowLayout {
                anchors.fill: parent
                spacing: 0

                Sidebar {
                    id: sidebar

                    Layout.preferredWidth: root.sidebarCollapsed ? 0 : implicitWidth
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
                    Layout.preferredWidth: sidebar.implicitWidth
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
