import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import T3.Shell

// The right panel: native tabs over an HTML body. The body is the app's
// embed route for the current thread, loaded in a second web surface that
// shares the primary surface's session; the tab model comes from
// Shell.state.rightPanel and every tab action goes back to the page.
Rectangle {
    id: panel

    readonly property var model: Shell.state.rightPanel ?? null
    readonly property bool available: model !== null
    readonly property bool open: available && model.isOpen
    readonly property int openWidth: 520
    readonly property color foreground: Theme.color("text", "#e4e4e7")
    readonly property color muted: Theme.color("textMuted", "#8b8b93")
    readonly property url embedUrl: {
        if (!available) {
            return "";
        }
        const page = Shell.pageUrl.toString();
        const origin = page.match(/^(https?:\/\/[^/]+)/);
        return origin ? origin[1] + model.embedPath : "";
    }

    // Whether the panel draws its own open/close button. A layout that puts
    // the toggle in the header strip (Workspace.panelToggle) turns this off,
    // and the closed panel then takes no width.
    property bool ownToggle: true

    implicitWidth: open ? openWidth : ownToggle ? 36 : 0
    color: Theme.color("chrome", "#0b0b0d")
    clip: true

    Behavior on implicitWidth {
        NumberAnimation {
            duration: 220
            easing.type: Easing.OutCubic
        }
    }

    ColumnLayout {
        id: column

        anchors.fill: parent
        spacing: 0

        Item {
            id: header

            Layout.fillWidth: true
            Layout.preferredHeight: 36
            Layout.minimumHeight: 36
            Layout.maximumHeight: 36

            ShellButton {
                id: toggleButton
                subtle: true

                anchors.left: parent.left
                anchors.top: parent.top
                width: 36
                height: 36
                visible: panel.ownToggle
                iconName: panel.open ? "panel-right-close" : "panel-right"
                iconSize: 16
                iconTint: panel.muted
                enabled: panel.available
                Accessible.name: panel.open ? qsTr("Close panel") : qsTr("Open panel")
                onClicked: Shell.dispatch("rightPanel.toggle")
            }

            ListView {
                id: tabs

                anchors.left: parent.left
                anchors.leftMargin: panel.ownToggle ? 36 : 8
                anchors.right: addButton.left
                anchors.top: parent.top
                height: 36
                visible: panel.open
                orientation: ListView.Horizontal
                spacing: 2
                clip: true
                boundsBehavior: Flickable.StopAtBounds
                model: panel.open ? panel.model.surfaces : []

                delegate: Rectangle {
                    id: tab

                    required property var modelData

                    readonly property bool active: panel.model.activeSurfaceId === modelData.id

                    width: tabRow.implicitWidth + 16
                    height: 36
                    color: active ? Theme.color("surfaceRaised", "#1f1f24") : tabHover.hovered ? Theme.color("surface", "#141416") : "transparent"
                    radius: 6

                    HoverHandler {
                        id: tabHover
                    }

                    TapHandler {
                        onTapped: Shell.dispatch("rightPanel.activate", {
                            id: tab.modelData.id
                        })
                    }

                    Row {
                        id: tabRow

                        anchors.centerIn: parent
                        spacing: 6

                        Text {
                            text: tab.modelData.title
                            color: tab.active ? panel.foreground : panel.muted
                            font.pixelSize: 12
                            anchors.verticalCenter: parent.verticalCenter
                        }

                        ShellIcon {
                            name: "x"
                            size: 12
                            color: panel.muted
                            anchors.verticalCenter: parent.verticalCenter

                            TapHandler {
                                onTapped: Shell.dispatch("rightPanel.close", {
                                    id: tab.modelData.id
                                })
                            }
                        }
                    }
                }
            }

            ShellButton {
                id: addButton
                subtle: true

                anchors.right: parent.right
                anchors.top: parent.top
                width: 36
                height: 36
                leftPadding: 10
                rightPadding: 10
                iconName: "plus"
                iconSize: 16
                iconTint: panel.muted
                visible: panel.open
                Accessible.name: qsTr("Add panel")
                onClicked: addMenu.open()

                ShellMenu {
                    id: addMenu

                    y: parent.height

                    ShellMenuItem {
                        text: qsTr("Diff")
                        iconName: "file-diff"
                        enabled: panel.open && panel.model.canAdd.diff
                        onTriggered: Shell.dispatch("rightPanel.add", {
                            kind: "diff"
                        })
                    }

                    ShellMenuItem {
                        text: qsTr("Files")
                        iconName: "files"
                        enabled: panel.open && panel.model.canAdd.files
                        onTriggered: Shell.dispatch("rightPanel.add", {
                            kind: "files"
                        })
                    }

                    ShellMenuItem {
                        text: qsTr("Terminal")
                        iconName: "terminal"
                        enabled: panel.open && panel.model.canAdd.terminal
                        onTriggered: Shell.dispatch("rightPanel.add", {
                            kind: "terminal"
                        })
                    }

                    ShellMenuItem {
                        text: qsTr("Pull request")
                        iconName: "git-pull-request"
                        enabled: panel.open && panel.model.canAdd.pullRequest
                        onTriggered: Shell.dispatch("rightPanel.add", {
                            kind: "pullRequest"
                        })
                    }

                    ShellMenuItem {
                        text: qsTr("Agents")
                        iconName: "bot"
                        enabled: panel.open && panel.model.canAdd.agents
                        onTriggered: Shell.dispatch("rightPanel.add", {
                            kind: "agents"
                        })
                    }
                }
            }
        }

        Loader {
            id: body

            // Once up, the document stays up: closing the panel or leaving the
            // thread route (settings) hides it instead of destroying the
            // terminals and scroll state it holds.
            readonly property bool wanted: panel.open && panel.embedUrl.toString().length > 0

            Layout.fillWidth: true
            Layout.fillHeight: true
            active: false
            visible: panel.open
            onWantedChanged: if (wanted) active = true
            Component.onCompleted: if (wanted) active = true

            // The document follows thread changes itself (t3Shell.onState), so
            // the URL is only the starting point; rebinding it would reload.
            sourceComponent: WebSurface {
                surfaceId: "rightPanel"
                Component.onCompleted: url = panel.embedUrl
            }
        }
    }
}
