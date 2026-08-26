import QtQuick
import QtQuick.Controls.Basic
import T3.Shell

// A button in the page's clothes: same radius, surface, border and fonts as
// the HTML controls, from Theme (theme.json, else the page's live theme).
Button {
    id: control

    property bool primary: false
    property bool subtle: false
    // Shows a down chevron instead of text (split-button menus).
    property bool chevron: false
    property color tint: primary ? Theme.color("accentForeground", "#ffffff") : Theme.color("text", "#e4e4e7")

    implicitHeight: 30
    leftPadding: chevron ? 6 : 10
    rightPadding: chevron ? 6 : 10
    font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
    font.pixelSize: 13
    hoverEnabled: true

    background: Rectangle {
        radius: Math.min(Theme.radius, control.height / 2)
        color: !control.enabled ? (control.primary ? Theme.color("accent", "#2563eb") : "transparent") : control.primary ? (control.down ? Qt.darker(Theme.color("accent", "#2563eb"), 1.15) : control.hovered ? Qt.lighter(Theme.color("accent", "#2563eb"), 1.08) : Theme.color("accent", "#2563eb")) : control.subtle ? (control.down || control.hovered ? Theme.color("surfaceRaised", "#27272a") : "transparent") : (control.down ? Theme.color("surfaceRaised", "#27272a") : control.hovered ? Theme.color("toolbarControlHover", "#27272a") : Theme.color("toolbarControl", "#18181b"))
        border.color: control.primary || control.subtle ? "transparent" : Theme.color("border", "#27272a")
        border.width: control.primary || control.subtle ? 0 : 1
        opacity: control.enabled ? 1 : 0.5
    }

    contentItem: Item {
        implicitWidth: control.chevron ? 9 : label.implicitWidth
        implicitHeight: control.chevron ? 6 : label.implicitHeight

        Text {
            id: label

            anchors.fill: parent
            visible: !control.chevron
            text: control.text
            font: control.font
            color: control.tint
            opacity: control.enabled ? 1 : 0.5
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
        }

        ShellChevron {
            anchors.centerIn: parent
            visible: control.chevron
            color: control.tint
            opacity: control.enabled ? 1 : 0.5
        }
    }
}
