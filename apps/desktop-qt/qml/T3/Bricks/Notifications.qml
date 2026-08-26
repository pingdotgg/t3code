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
    property int cardWidth: 360

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
                implicitHeight: body.implicitHeight + 24
                radius: Theme.radius
                color: Theme.color("surfaceOverlay", "#18181b")
                border.color: Theme.color("border", "#27272a")
                border.width: 1

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
                    anchors.margins: 12
                    anchors.leftMargin: 16
                    spacing: 6

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8

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
                            subtle: true
                            implicitWidth: 24
                            implicitHeight: 24
                            leftPadding: 0
                            rightPadding: 0
                            text: "✕"
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
                        wrapMode: Text.Wrap
                    }

                    RowLayout {
                        Layout.fillWidth: true
                        visible: card.modelData.actions.length > 0
                        spacing: 6

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
