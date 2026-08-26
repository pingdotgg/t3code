import QtQuick
import QtQuick.Controls.Basic
import T3.Shell

// A select in the page's clothes.
ComboBox {
    id: control

    implicitHeight: 30
    leftPadding: 10
    rightPadding: 28
    font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
    font.pixelSize: 13
    hoverEnabled: true

    background: Rectangle {
        radius: Math.min(Theme.radius, control.height / 2)
        color: control.down || control.hovered ? Theme.color("toolbarControlHover", "#27272a") : Theme.color("toolbarControl", "#18181b")
        border.color: control.activeFocus ? Theme.color("focus", "#3b82f6") : Theme.color("border", "#27272a")
        border.width: 1
        opacity: control.enabled ? 1 : 0.5
    }

    contentItem: Text {
        text: control.displayText
        font: control.font
        color: Theme.color("text", "#e4e4e7")
        opacity: control.enabled ? 1 : 0.5
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
    }

    indicator: ShellChevron {
        x: control.width - width - 11
        y: (control.height - height) / 2
        color: Theme.color("textMuted", "#8b8b93")
    }

    delegate: ItemDelegate {
        id: item

        required property var model
        required property int index

        width: ListView.view.width
        height: 30
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
            color: item.highlighted || item.hovered ? Theme.color("sidebarRowHover", "#27272a") : "transparent"
        }
    }

    popup: Popup {
        y: control.height + 4
        width: Math.max(control.width, 200)
        implicitHeight: Math.min(contentItem.implicitHeight + 8, 320)
        padding: 4

        contentItem: ListView {
            clip: true
            implicitHeight: contentHeight
            model: control.popup.visible ? control.delegateModel : null
            currentIndex: control.highlightedIndex
            boundsBehavior: Flickable.StopAtBounds
        }

        background: Rectangle {
            radius: Theme.radius
            color: Theme.color("surfaceOverlay", "#18181b")
            border.color: Theme.color("border", "#27272a")
            border.width: 1
        }
    }
}
