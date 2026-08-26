import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import T3.Shell
import T3.Bricks

// Warm dashboard: a tab strip on top, everything else in rounded cards on a
// soft canvas. Tabs switch between the chat, the panel and settings.
Window {
    id: root

    readonly property color canvas: Theme.color("canvas", "#f4ece4")
    readonly property color card: Theme.color("surface", "#fffaf6")
    readonly property color line: Theme.color("border", "#e5d6ca")
    readonly property bool settingsActive: Shell.state.settings ? Shell.state.settings.active : false

    width: 1360
    height: 860
    visible: true
    title: qsTr("T3 Code")
    color: canvas
    opacity: Theme.windowOpacity
    flags: Qt.Window | Qt.FramelessWindowHint

    component Card: Rectangle {
        default property alias content: inner.data

        radius: Theme.radius
        color: root.card
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
        anchors.margins: 16
        spacing: 12

        // Top: window controls + tab strip.
        RowLayout {
            Layout.fillWidth: true
            spacing: 12

            TitleBar {
                Layout.preferredWidth: 120
                Layout.preferredHeight: 36
                window: root
                color: "transparent"
            }

            TabBar {
                id: tabs

                Layout.preferredWidth: 420
                background: null

                SoftTab {
                    text: qsTr("Chat")
                    onClicked: if (root.settingsActive)
                        Shell.dispatch("settings.back")
                }

                SoftTab {
                    text: qsTr("Changes")
                }

                SoftTab {
                    text: qsTr("Settings")
                    onClicked: Shell.dispatch("settings.open")
                }
            }

            Workspace {
                Layout.fillWidth: true
                Layout.preferredHeight: 36
                visible: ready
                color: "transparent"
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 12

            Card {
                Layout.preferredWidth: 280
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

            ColumnLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: 12

                Card {
                    Layout.fillWidth: true
                    Layout.fillHeight: true

                    WebSurface {
                        anchors.fill: parent
                        url: Shell.pageUrl
                    }
                }

                Card {
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

            Card {
                Layout.preferredWidth: panel.implicitWidth
                Layout.fillHeight: true
                visible: panel.available && (tabs.currentIndex === 1 || panel.open)

                RightPanel {
                    id: panel

                    anchors.fill: parent
                    color: "transparent"
                }
            }
        }
    }

    component SoftTab: TabButton {
        font.pixelSize: 13
        font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family

        contentItem: Text {
            text: parent.text
            color: parent.checked ? Theme.color("accent", "#b46a5a") : Theme.color("textMuted", "#9a8a80")
            font: parent.font
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
        }

        background: Rectangle {
            color: "transparent"

            Rectangle {
                anchors.bottom: parent.bottom
                anchors.horizontalCenter: parent.horizontalCenter
                width: parent.parent.checked ? parent.width * 0.6 : 0
                height: 2
                radius: 1
                color: Theme.color("accent", "#b46a5a")
            }
        }
    }

    Notifications {
        anchors.bottom: parent.bottom
        anchors.right: parent.right
        anchors.margins: 24
    }

    ContextMenuHost {
        surfaceId: "shell"
    }

    ShellErrorOverlay {
        anchors.fill: parent
    }
}
