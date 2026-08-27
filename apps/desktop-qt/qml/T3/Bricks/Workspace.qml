import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import T3.Shell

// The header strip: project / thread breadcrumb on the left, the run, open
// and git pills on the right, from Shell.state.workspace. Checkout mode and
// branch live under the Composer, as in the page.
Rectangle {
    id: strip

    readonly property var model: Shell.state.workspace ?? null
    readonly property bool ready: model !== null
    readonly property color foreground: Theme.color("text", "#e4e4e7")
    readonly property color muted: Theme.color("textMuted", "#8b8b93")
    readonly property color iconMuted: Theme.color("iconMuted", "#8b8b93")
    readonly property var preferredScript: {
        if (!ready || model.scripts.length === 0) {
            return null;
        }
        return model.scripts.find(script => script.id === model.preferredScriptId) ?? model.scripts[0];
    }

    // Set by the layout: whether the sidebar is collapsed. Null hides the
    // toggle; true shows it in the sidebar's place.
    property var sidebarToggle: null
    // Same for the right panel: null hides the toggle, otherwise whether the
    // panel is open. The page's header keeps this button next to the pills.
    property var panelToggle: null
    // The window, for a frameless shell: the strip is its drag handle and
    // carries the window buttons.
    property Window window: null
    readonly property bool framelessChrome: window !== null && Theme.frameless
    // Narrow strips (a wide right panel) drop the pill labels.
    readonly property bool compact: width < 720

    implicitHeight: 52
    color: Theme.color("canvas", "#0f0f12")

    DragHandler {
        enabled: strip.framelessChrome
        target: null
        grabPermissions: PointerHandler.CanTakeOverFromAnything
        onActiveChanged: if (active)
            strip.window.startSystemMove()
    }

    TapHandler {
        enabled: strip.framelessChrome
        onDoubleTapped: strip.window.visibility === Window.Maximized ? strip.window.showNormal() : strip.window.showMaximized()
    }

    ShellButton {
        x: 12
        y: 12
        subtle: true
        implicitHeight: 28
        visible: strip.sidebarToggle === true
        iconName: "panel-left"
        iconSize: 16
        iconTint: strip.iconMuted
        Accessible.name: qsTr("Show sidebar")
        onClicked: Shell.dispatch("sidebar.toggle")
    }

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: strip.sidebarToggle === true ? 52 : 20
        anchors.rightMargin: 20
        spacing: 12

        // Breadcrumb: project / title.
        RowLayout {
            Layout.fillWidth: true
            Layout.minimumWidth: 0
            spacing: 6

            ShellIcon {
                visible: strip.ready && strip.model.projectTitle !== null
                name: "folder"
                size: 14
                color: strip.iconMuted
                Layout.alignment: Qt.AlignVCenter
            }

            Text {
                id: projectLabel

                Layout.fillWidth: true
                Layout.minimumWidth: 24
                Layout.maximumWidth: Math.min(implicitWidth, 160)
                visible: strip.ready && strip.model.projectTitle !== null
                text: strip.ready ? (strip.model.projectTitle ?? "") : ""
                color: projectHover.hovered ? strip.foreground : strip.muted
                font.pixelSize: 14
                font.weight: Font.Medium
                font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                elide: Text.ElideRight
                Accessible.role: Accessible.Button
                Accessible.name: qsTr("New thread in project")

                Behavior on color {
                    ColorAnimation {
                        duration: 120
                    }
                }

                HoverHandler {
                    id: projectHover

                    cursorShape: Qt.PointingHandCursor
                }

                TapHandler {
                    onTapped: Shell.dispatch("workspace.newThread")
                }
            }

            Text {
                visible: strip.ready && strip.model.projectTitle !== null
                text: "/"
                color: strip.iconMuted
                font.pixelSize: 14
                font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
            }

            Item {
                id: titleSlot

                property bool editing: false
                property int handledRenameRequest: 0

                function startEditing() {
                    editing = true;
                    titleEditor.text = strip.model.threadTitle;
                    titleEditor.forceActiveFocus();
                    titleEditor.selectAll();
                }

                Layout.fillWidth: true
                Layout.minimumWidth: 24
                implicitHeight: 28
                implicitWidth: titleRow.implicitWidth

                Connections {
                    target: strip

                    function onModelChanged() {
                        if (strip.ready && strip.model.renameRequestId !== titleSlot.handledRenameRequest) {
                            titleSlot.handledRenameRequest = strip.model.renameRequestId;
                            if (strip.model.renameRequestId > 0) {
                                titleSlot.startEditing();
                            }
                        }
                    }
                }

                HoverHandler {
                    id: titleHover

                    enabled: !titleSlot.editing && strip.ready && !strip.model.isDraft
                    cursorShape: Qt.PointingHandCursor
                }

                TapHandler {
                    enabled: !titleSlot.editing
                    acceptedButtons: Qt.LeftButton | Qt.RightButton
                    onTapped: eventPoint => {
                        if (!strip.ready || strip.model.isDraft) {
                            return;
                        }
                        const p = titleSlot.mapToItem(null, 0, titleSlot.height + 4);
                        Shell.dispatch("workspace.titleMenu", {
                            x: p.x,
                            y: p.y
                        });
                    }
                    onDoubleTapped: {
                        if (strip.ready && !strip.model.isDraft) {
                            titleSlot.startEditing();
                        }
                    }
                }

                RowLayout {
                    id: titleRow

                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    width: Math.min(implicitWidth, parent.width)
                    visible: !titleSlot.editing
                    spacing: 4

                    Text {
                        Layout.fillWidth: true
                        Layout.maximumWidth: implicitWidth
                        text: strip.ready ? strip.model.threadTitle : qsTr("No thread")
                        color: strip.foreground
                        font.pixelSize: 14
                        font.weight: Font.Medium
                        font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                        elide: Text.ElideRight
                    }

                    ShellIcon {
                        name: "chevron-down"
                        size: 14
                        color: strip.muted
                        opacity: titleHover.hovered ? 1 : 0
                        Layout.alignment: Qt.AlignVCenter

                        Behavior on opacity {
                            NumberAnimation {
                                duration: 120
                            }
                        }
                    }
                }

                ShellTextField {
                    id: titleEditor

                    anchors.fill: parent
                    visible: titleSlot.editing
                    font.pixelSize: 14
                    font.weight: Font.Medium
                    onAccepted: {
                        titleSlot.editing = false;
                        Shell.dispatch("workspace.rename", {
                            title: text
                        });
                    }
                    Keys.onEscapePressed: titleSlot.editing = false
                    onActiveFocusChanged: if (!activeFocus && titleSlot.editing) {
                        titleSlot.editing = false;
                    }
                }
            }
        }

        ShellSplitButton {
            id: scriptsPill

            visible: strip.ready && strip.model.scripts.length > 0
            compact: strip.compact
            iconName: "play"
            text: strip.preferredScript ? qsTr("Run %1").arg(strip.preferredScript.name) : ""
            onClicked: Shell.dispatch("workspace.runScript", {
                scriptId: strip.preferredScript.id
            })
            onMenuRequested: scriptsMenu.open()

            ShellMenu {
                id: scriptsMenu

                y: parent.height + 4
                x: parent.width - width

                Instantiator {
                    model: strip.ready ? strip.model.scripts : []

                    delegate: ShellMenuItem {
                        required property var modelData

                        text: modelData.name
                        iconName: "play"
                        current: strip.preferredScript !== null && modelData.id === strip.preferredScript.id
                        onTriggered: Shell.dispatch("workspace.runScript", {
                            scriptId: modelData.id
                        })
                    }

                    onObjectAdded: (index, object) => scriptsMenu.insertItem(index, object)
                    onObjectRemoved: (index, object) => scriptsMenu.removeItem(object)
                }
            }
        }

        ShellSplitButton {
            visible: strip.ready && strip.model.editors.length > 0
            compact: strip.compact
            iconName: "external-link"
            text: qsTr("Open")
            onClicked: Shell.dispatch("workspace.openInEditor", {})
            onMenuRequested: editorsMenu.open()

            ShellMenu {
                id: editorsMenu

                y: parent.height + 4
                x: parent.width - width

                Instantiator {
                    model: strip.ready ? strip.model.editors : []

                    delegate: ShellMenuItem {
                        required property var modelData

                        text: modelData.label
                        current: strip.ready && modelData.id === strip.model.preferredEditorId
                        onTriggered: Shell.dispatch("workspace.openInEditor", {
                            editorId: modelData.id
                        })
                    }

                    onObjectAdded: (index, object) => editorsMenu.insertItem(index, object)
                    onObjectRemoved: (index, object) => editorsMenu.removeItem(object)
                }
            }
        }

        GitActions {
            compact: strip.compact
        }

        ShellButton {
            visible: strip.panelToggle !== null
            subtle: true
            implicitHeight: 28
            iconName: strip.panelToggle === true ? "panel-right-close" : "panel-right"
            iconSize: 16
            iconTint: strip.iconMuted
            Layout.leftMargin: 4
            Accessible.name: strip.panelToggle === true ? qsTr("Close panel") : qsTr("Open panel")
            onClicked: Shell.dispatch("rightPanel.toggle")
        }

        WindowControls {
            visible: strip.framelessChrome && Qt.platform.os !== "osx"
            window: strip.window
            buttonWidth: 32
            buttonHeight: 28
            Layout.leftMargin: 8
        }
    }
}
