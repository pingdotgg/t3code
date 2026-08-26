import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import T3.Shell

// The workspace strip: project / thread breadcrumb, checkout context and
// branch, open-in-editor and project scripts, from Shell.state.workspace.
// Git commit/push/PR actions stay with the page's own control.
Rectangle {
    id: strip

    readonly property var model: Shell.state.workspace ?? null
    readonly property bool ready: model !== null
    readonly property color foreground: Theme.color("toolbarForeground", "#e4e4e7")
    readonly property color muted: Theme.color("textMuted", "#8b8b93")
    readonly property string gitSummary: {
        if (!ready || !model.git || !model.git.isRepo) {
            return "";
        }
        const parts = [];
        if (model.git.hasWorkingTreeChanges) {
            parts.push(qsTr("modified"));
        }
        if (model.git.aheadCount > 0) {
            parts.push("↑" + model.git.aheadCount);
        }
        if (model.git.behindCount > 0) {
            parts.push("↓" + model.git.behindCount);
        }
        return parts.join(" ");
    }

    implicitHeight: 40
    color: Theme.color("toolbar", "#0f0f12")

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 12
        anchors.rightMargin: 12
        spacing: 8

        ShellButton {
            subtle: true
            visible: strip.ready && strip.model.projectTitle !== null
            text: strip.ready ? (strip.model.projectTitle ?? "") : ""
            font.pixelSize: 13
            Accessible.name: qsTr("New thread in project")
            onClicked: Shell.dispatch("workspace.newThread")
        }

        Text {
            visible: strip.ready && strip.model.projectTitle !== null
            text: "/"
            color: strip.muted
        }

        Item {
            id: titleSlot

            Layout.fillWidth: true
            Layout.minimumWidth: 120
            implicitHeight: 30

            property bool editing: false
            property int handledRenameRequest: 0

            Connections {
                target: strip

                function onModelChanged() {
                    if (strip.ready && strip.model.renameRequestId !== titleSlot.handledRenameRequest) {
                        titleSlot.handledRenameRequest = strip.model.renameRequestId;
                        if (strip.model.renameRequestId > 0) {
                            titleSlot.editing = true;
                            titleEditor.text = strip.model.threadTitle;
                            titleEditor.forceActiveFocus();
                            titleEditor.selectAll();
                        }
                    }
                }
            }

            Text {
                anchors.fill: parent
                visible: !titleSlot.editing
                text: strip.ready ? strip.model.threadTitle : qsTr("No thread")
                color: strip.foreground
                font.pixelSize: 13
                font.bold: true
                font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                elide: Text.ElideRight
                verticalAlignment: Text.AlignVCenter

                TapHandler {
                    acceptedButtons: Qt.LeftButton | Qt.RightButton
                    onTapped: eventPoint => {
                        if (!strip.ready || strip.model.isDraft) {
                            return;
                        }
                        const p = titleSlot.mapToItem(null, eventPoint.position.x, eventPoint.position.y);
                        Shell.dispatch("workspace.titleMenu", {
                            x: p.x,
                            y: p.y
                        });
                    }
                }
            }

            ShellTextField {
                id: titleEditor

                anchors.fill: parent
                visible: titleSlot.editing
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

        ShellComboBox {
            visible: strip.ready && strip.model.envModeChangeable
            Layout.preferredWidth: 170
            model: [qsTr("Current checkout"), qsTr("New worktree")]
            currentIndex: strip.ready && strip.model.envMode === "worktree" ? 1 : 0
            onActivated: index => Shell.dispatch("workspace.envMode.set", {
                    mode: index === 1 ? "worktree" : "local"
                })
        }

        Text {
            visible: strip.ready && !strip.model.envModeChangeable
            text: strip.ready ? strip.model.envModeLabel : ""
            color: strip.muted
            font.pixelSize: 12
        }

        ShellButton {
            id: branchButton
            subtle: true

            visible: strip.ready && (strip.model.branch !== null || strip.model.branchChangeable)
            enabled: strip.ready && strip.model.branchChangeable && !strip.model.branchSwitchPending
            text: strip.ready ? "⎇ " + (strip.model.branch ?? qsTr("Pick branch")) + (strip.gitSummary.length > 0 ? "  " + strip.gitSummary : "") : ""
            Layout.maximumWidth: 260
            font.pixelSize: 12
            Accessible.name: qsTr("Switch branch")
            onClicked: branchPicker.open()

            Popup {
                id: branchPicker

                y: parent.height
                width: 320
                height: 360
                padding: 8
                onOpened: {
                    branchSearch.text = "";
                    branchSearch.forceActiveFocus();
                }
                onClosed: Shell.dispatch("workspace.branch.search", {
                    query: ""
                })

                background: Rectangle {
                    color: Theme.color("surfaceOverlay", "#18181b")
                    border.color: Theme.color("border", "#27272a")
                    radius: 8
                }

                ColumnLayout {
                    anchors.fill: parent
                    spacing: 6

                    ShellTextField {
                        id: branchSearch

                        Layout.fillWidth: true
                        placeholderText: qsTr("Search or create a branch")
                        onTextEdited: Shell.dispatch("workspace.branch.search", {
                            query: text
                        })
                        Keys.onReturnPressed: {
                            const name = text.trim();
                            if (name.length === 0) {
                                return;
                            }
                            const exact = strip.model.branches.find(ref => ref.name === name);
                            Shell.dispatch(exact ? "workspace.branch.select" : "workspace.branch.create", {
                                name: name
                            });
                            branchPicker.close();
                        }
                    }

                    ListView {
                        id: branchList

                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true
                        boundsBehavior: Flickable.StopAtBounds
                        model: strip.ready ? strip.model.branches : []

                        delegate: Rectangle {
                            id: branchRow

                            required property var modelData

                            width: ListView.view.width
                            height: 30
                            radius: 6
                            color: rowHover.hovered ? Theme.color("sidebarRowHover", "#1c1c21") : "transparent"

                            HoverHandler {
                                id: rowHover
                            }

                            TapHandler {
                                onTapped: {
                                    Shell.dispatch("workspace.branch.select", {
                                        name: branchRow.modelData.name
                                    });
                                    branchPicker.close();
                                }
                            }

                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                anchors.left: parent.left
                                anchors.leftMargin: 8
                                anchors.right: parent.right
                                anchors.rightMargin: 8
                                text: (branchRow.modelData.current ? "● " : "") + branchRow.modelData.name + (branchRow.modelData.isDefault ? "  " + qsTr("default") : "")
                                color: branchRow.modelData.isRemote ? strip.muted : strip.foreground
                                font.pixelSize: 12
                                elide: Text.ElideMiddle
                            }
                        }

                        Text {
                            anchors.centerIn: parent
                            visible: branchList.count === 0
                            text: strip.ready && strip.model.branchesLoading ? qsTr("Loading refs…") : qsTr("No matching refs — Enter creates one")
                            color: strip.muted
                            font.pixelSize: 12
                        }
                    }

                    Text {
                        Layout.fillWidth: true
                        visible: strip.ready && strip.model.branchesTotal > strip.model.branches.length
                        text: strip.ready ? qsTr("Showing %1 of %2 refs — type to narrow").arg(strip.model.branches.length).arg(strip.model.branchesTotal) : ""
                        color: strip.muted
                        font.pixelSize: 11
                    }
                }
            }
        }

        ShellButton {
            subtle: true
            visible: strip.ready && strip.model.canOpenPullRequest
            text: strip.ready && strip.model.git && strip.model.git.pullRequest ? "#" + strip.model.git.pullRequest.number : ""
            font.pixelSize: 12
            Accessible.name: qsTr("Open pull request")
            onClicked: Shell.dispatch("workspace.openPullRequest")
        }

        GitActions {}

        ShellButton {
            id: scriptsButton
            subtle: true

            visible: strip.ready && strip.model.scripts.length > 0
            text: qsTr("Run")
            onClicked: scriptsMenu.open()

            ShellMenu {
                id: scriptsMenu

                y: parent.height

                Repeater {
                    model: strip.ready ? strip.model.scripts : []

                    ShellMenuItem {
                        required property var modelData

                        text: modelData.name
                        onTriggered: Shell.dispatch("workspace.runScript", {
                            scriptId: modelData.id
                        })
                    }
                }
            }
        }

        ShellButton {
            id: openButton
            subtle: true

            visible: strip.ready && strip.model.editors.length > 0
            text: qsTr("Open")
            onClicked: Shell.dispatch("workspace.openInEditor", {})
        }

        ShellButton {
            subtle: true
            visible: openButton.visible
            chevron: true
            Accessible.name: qsTr("Choose editor")
            onClicked: editorsMenu.open()

            ShellMenu {
                id: editorsMenu

                y: parent.height

                Repeater {
                    model: strip.ready ? strip.model.editors : []

                    ShellMenuItem {
                        required property var modelData

                        text: modelData.label + (strip.ready && modelData.id === strip.model.preferredEditorId ? " ✓" : "")
                        onTriggered: Shell.dispatch("workspace.openInEditor", {
                            editorId: modelData.id
                        })
                    }
                }
            }
        }
    }
}
