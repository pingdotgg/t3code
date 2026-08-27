import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import T3.Shell
import T3.Bricks

// Midnight glass: a transparent window (let the compositor blur it), a big
// clock in the top bar, and every brick floating in its own translucent card.
Window {
    id: root

    property date now: new Date()

    readonly property bool settingsActive: Shell.state.settings ? Shell.state.settings.active : false
    readonly property color glass: Qt.rgba(Theme.color("surface", "#1b2033").r, Theme.color("surface", "#1b2033").g, Theme.color("surface", "#1b2033").b, 0.6)
    readonly property color line: Qt.rgba(1, 1, 1, 0.08)

    width: 1400
    height: 880
    visible: true
    title: qsTr("T3 Code")
    // macOS blurs in proportion to alpha, so the gaps keep a faint tint
    // instead of going fully clear.
    color: Theme.windowTransparent ? Qt.rgba(Theme.color("canvas", "#141826").r, Theme.color("canvas", "#141826").g, Theme.color("canvas", "#141826").b, 0.3) : Theme.color("canvas", "#141826")
    opacity: Theme.windowOpacity
    flags: Qt.Window | Qt.FramelessWindowHint

    Timer {
        interval: 1000
        running: true
        repeat: true
        onTriggered: root.now = new Date()
    }

    component Glass: Rectangle {
        default property alias content: inner.data

        radius: Theme.radius
        color: root.glass
        border.color: root.line
        border.width: 1
        clip: true

        Item {
            id: inner

            anchors.fill: parent
            anchors.margins: 1
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 18
        spacing: 14

        RowLayout {
            Layout.fillWidth: true
            spacing: 14

            Glass {
                Layout.preferredWidth: 300
                Layout.preferredHeight: 64

                RowLayout {
                    anchors.fill: parent
                    anchors.leftMargin: 16
                    spacing: 14

                    Text {
                        text: Qt.formatTime(root.now, "H:mm:ss")
                        color: Theme.color("text", "#e7e9f5")
                        font.pixelSize: 28
                        font.family: Theme.fontMono.length > 0 ? Theme.fontMono : "Menlo"
                    }

                    Text {
                        Layout.fillWidth: true
                        text: Qt.formatDate(root.now, "dddd d MMMM").toUpperCase()
                        color: Theme.color("textMuted", "#8f95b3")
                        font.pixelSize: 11
                        font.letterSpacing: 1.5
                    }
                }
            }

            Glass {
                Layout.fillWidth: true
                Layout.preferredHeight: 64

                Workspace {
                    anchors.fill: parent
                    anchors.leftMargin: 8
                    visible: ready
                    color: "transparent"
                }
            }

            Glass {
                Layout.preferredWidth: 130
                Layout.preferredHeight: 64

                TitleBar {
                    anchors.fill: parent
                    window: root
                    color: "transparent"
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 14

            Glass {
                Layout.preferredWidth: 290
                Layout.fillHeight: true

                Sidebar {
                    anchors.fill: parent
                    visible: !root.settingsActive
                    color: "transparent"
                }

                SettingsNav {
                    anchors.fill: parent
                    visible: root.settingsActive
                    color: "transparent"
                }
            }

            Glass {
                Layout.fillWidth: true
                Layout.fillHeight: true

                WebSurface {
                    anchors.fill: parent
                    url: Shell.pageUrl
                }
            }

            Glass {
                Layout.preferredWidth: panel.implicitWidth
                Layout.fillHeight: true
                visible: panel.available

                RightPanel {
                    id: panel

                    anchors.fill: parent
                    color: "transparent"
                }
            }
        }

        Glass {
            Layout.fillWidth: true
            Layout.preferredHeight: composer.implicitHeight
            visible: composer.ready

            Composer {
                id: composer

                anchors.fill: parent
                color: "transparent"
            }
        }
    }

    Notifications {
        anchors.top: parent.top
        anchors.right: parent.right
        anchors.topMargin: 96
        anchors.rightMargin: 24
    }

    ContextMenuHost {
        surfaceId: "shell"
    }

    ShellErrorOverlay {
        anchors.fill: parent
    }
}
