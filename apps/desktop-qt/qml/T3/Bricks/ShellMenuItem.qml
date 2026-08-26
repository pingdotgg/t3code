import QtQuick
import QtQuick.Controls.Basic
import T3.Shell

MenuItem {
    id: control

    property bool destructive: false

    implicitHeight: 30
    leftPadding: 10
    rightPadding: 10
    font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
    font.pixelSize: 13
    hoverEnabled: true

    contentItem: Text {
        text: control.text
        font: control.font
        color: control.destructive ? Theme.color("error", "#ef4444") : Theme.color("text", "#e4e4e7")
        opacity: control.enabled ? 1 : 0.5
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
    }

    background: Rectangle {
        radius: 6
        color: control.highlighted || control.hovered ? Theme.color("sidebarRowHover", "#27272a") : "transparent"
    }
}
