import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import T3.Shell

// The page's toasts, rendered natively (Shell.state.notifications). Place it
// over the window; the page keeps timing and dismissal semantics.
Item {
    id: host

    readonly property var model: Shell.state.notifications ?? null
    readonly property var items: model ? model.items : []
    property int cardWidth: 340

    implicitWidth: cardWidth
    implicitHeight: column.implicitHeight
    visible: items.length > 0

    function typeColor(type) {
        switch (type) {
        case "error":
            return Theme.color("error", "#ef4444");
        case "warning":
            return Theme.color("warning", "#e0af68");
        case "success":
            return Theme.color("update", "#22c55e");
        case "loading":
            return Theme.color("textMuted", "#8b8b93");
        default:
            return Theme.color("accent", "#3b82f6");
        }
    }

    ColumnLayout {
        id: column

        anchors.right: parent.right
        anchors.top: parent.top
        width: host.cardWidth
        spacing: 8

        Repeater {
            model: host.items

            delegate: Rectangle {
                id: card

                required property var modelData

                Layout.fillWidth: true
                implicitHeight: body.implicitHeight + 28
                radius: Theme.radius
                color: Theme.color("surfaceOverlay", "#18181b")
                border.color: Theme.color("border", "#27272a")
                border.width: 1
                transform: Translate {
                    id: slide
                }

                // Slide in from the edge, like the page's own toasts.
                ParallelAnimation {
                    running: true

                    NumberAnimation {
                        target: card
                        property: "opacity"
                        from: 0
                        to: 1
                        duration: 180
                    }

                    NumberAnimation {
                        target: slide
                        property: "x"
                        from: 24
                        to: 0
                        duration: 220
                        easing.type: Easing.OutCubic
                    }
                }

                Rectangle {
                    anchors.left: parent.left
                    anchors.top: parent.top
                    anchors.bottom: parent.bottom
                    anchors.margins: 1
                    width: 3
                    radius: 2
                    color: host.typeColor(card.modelData.type)
                }

                ColumnLayout {
                    id: body

                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.margins: 14
                    anchors.leftMargin: 18
                    spacing: 6

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 10

                        Text {
                            Layout.fillWidth: true
                            text: card.modelData.title
                            color: Theme.color("text", "#e4e4e7")
                            font.pixelSize: 13
                            font.bold: true
                            font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                            wrapMode: Text.Wrap
                        }

                        ShellButton {
                            Layout.alignment: Qt.AlignTop
                            Layout.topMargin: -4
                            Layout.rightMargin: -6
                            subtle: true
                            implicitWidth: 26
                            implicitHeight: 26
                            leftPadding: 0
                            rightPadding: 0
                            text: "✕"
                            tint: Theme.color("textMuted", "#8b8b93")
                            font.pixelSize: 11
                            Accessible.name: qsTr("Dismiss")
                            onClicked: Shell.dispatch("notification.dismiss", {
                                id: card.modelData.id
                            })
                        }
                    }

                    Text {
                        Layout.fillWidth: true
                        visible: card.modelData.description !== null && card.modelData.description.length > 0
                        text: card.modelData.description ?? ""
                        color: Theme.color("textMuted", "#8b8b93")
                        font.pixelSize: 12
                        font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                        lineHeight: 1.2
                        wrapMode: Text.Wrap
                    }

                    RowLayout {
                        Layout.fillWidth: true
                        Layout.topMargin: 4
                        visible: card.modelData.actions.length > 0
                        spacing: 8

                        Item {
                            Layout.fillWidth: true
                        }

                        Repeater {
                            model: card.modelData.actions

                            delegate: ShellButton {
                                required property var modelData

                                primary: modelData.primary
                                text: modelData.label
                                onClicked: Shell.dispatch("notification.action", {
                                    id: card.modelData.id,
                                    actionId: modelData.id
                                })
                            }
                        }
                    }
                }
            }
        }
    }
}
