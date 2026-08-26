import QtQuick
import QtQuick.Controls.Basic
import T3.Shell

// A text input in the page's clothes.
TextField {
    id: control

    implicitHeight: 30
    leftPadding: 10
    rightPadding: 10
    font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
    font.pixelSize: 13
    color: Theme.color("text", "#e4e4e7")
    placeholderTextColor: Theme.color("placeholder", "#71717a")
    selectionColor: Theme.color("accent", "#2563eb")
    selectedTextColor: Theme.color("accentForeground", "#ffffff")

    background: Rectangle {
        radius: Math.min(Theme.radius, control.height / 2)
        color: Theme.color("input", "#18181b")
        border.color: control.activeFocus ? Theme.color("focus", "#3b82f6") : Theme.color("border", "#27272a")
        border.width: 1
    }
}
