import QtQuick
import QtQuick.Controls.Basic
import T3.Shell

// A select in the page's clothes: the composer's ghost pickers by default
// (icon, muted label, chevron), `outline: true` for a bordered field.
ComboBox {
    id: control

    property bool outline: false
    property string iconName: ""
    property real iconSize: 16
    property real chevronSize: 14
    readonly property color hoverFill: Qt.alpha(Theme.color("accentSurface", "#27272a"), outline ? 0.5 : 1)
    readonly property color labelColor: control.hovered || control.down || control.popup.visible ? Theme.color("text", "#e4e4e7") : Theme.color("secondaryLabel", "#a1a1aa")

    implicitHeight: 28
    leftPadding: iconName.length > 0 ? 10 + iconSize + 6 : 10
    rightPadding: 10 + chevronSize + 4
    font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
    font.pixelSize: 14
    font.weight: Font.Medium
    hoverEnabled: true
    opacity: enabled ? 1 : 0.64

    background: Rectangle {
        radius: Math.min(Theme.radius, 8)
        color: control.down || control.hovered || control.popup.visible ? control.hoverFill : control.outline ? Qt.alpha(Theme.color("input", "#27272a"), 0.32) : "transparent"
        border.color: control.outline ? (control.activeFocus ? Theme.color("focus", "#3b82f6") : Theme.color("input", "#27272a")) : "transparent"
        border.width: control.outline ? 1 : 0

        Behavior on color {
            ColorAnimation {
                duration: 120
            }
        }

        ShellIcon {
            x: 10
            y: (parent.height - height) / 2
            visible: control.iconName.length > 0
            name: control.iconName
            size: control.iconSize
            color: control.labelColor
        }
    }

    contentItem: Text {
        text: control.displayText
        font: control.font
        color: control.labelColor
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
    }

    indicator: ShellIcon {
        x: control.width - width - 10
        y: (control.height - height) / 2
        name: "chevron-down"
        size: control.chevronSize
        strokeWidth: 2.25
        color: Theme.color("iconMuted", "#8b8b93")
    }

    delegate: ItemDelegate {
        id: item

        required property var model
        required property int index

        width: ListView.view.width
        height: 28
        leftPadding: 8
        rightPadding: 8
        hoverEnabled: true

        contentItem: Text {
            text: item.model[control.textRole] ?? item.model.modelData ?? item.model.display ?? ""
            font: control.font
            color: Theme.color("text", "#e4e4e7")
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
        }

        background: Rectangle {
            radius: 6
            color: item.highlighted || item.hovered ? Theme.color("accentSurface", "#27272a") : "transparent"
        }
    }

    popup: Popup {
        y: control.height + 4
        width: Math.max(control.width, 160)
        implicitHeight: Math.min(contentItem.implicitHeight + 8, 320)
        padding: 4

        enter: Transition {
            NumberAnimation {
                property: "opacity"
                from: 0
                to: 1
                duration: 120
                easing.type: Easing.OutCubic
            }
        }

        exit: Transition {
            NumberAnimation {
                property: "opacity"
                from: 1
                to: 0
                duration: 90
            }
        }

        contentItem: ListView {
            clip: true
            implicitHeight: contentHeight
            model: control.popup.visible ? control.delegateModel : null
            currentIndex: control.highlightedIndex
            boundsBehavior: Flickable.StopAtBounds
        }

        background: Rectangle {
            radius: Math.min(Theme.radius, 10)
            color: Theme.color("surfaceOverlay", "#18181b")
            border.color: Qt.alpha(Theme.color("text", "#e4e4e7"), 0.1)
            border.width: 1
        }
    }
}
