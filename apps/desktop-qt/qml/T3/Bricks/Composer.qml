import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Dialogs
import QtQuick.Layouts
import T3.Shell

// The prompt: text input, model/effort/mode pickers, send/stop, with the
// checkout context strip welded under it. Rendered from Shell.state.composer
// and Shell.state.workspace (see packages/contracts/src/shell.ts); every
// change is dispatched back and the web app remains the owner of drafts and
// sending.
Rectangle {
    id: composer

    readonly property var model: Shell.state.composer ?? null
    readonly property var workspace: Shell.state.workspace ?? null
    readonly property bool ready: model !== null && model.target !== null
    readonly property string publishedText: ready ? model.text : ""
    readonly property int publishedCursor: ready ? model.cursor : 0
    readonly property var suggestions: ready ? model.suggestions : []
    readonly property bool suggesting: ready && model.triggerKind !== null && (suggestions.length > 0 || model.suggestionsEmptyText !== null)
    readonly property color canvas: Theme.color("canvas", "#0f0f12")
    readonly property color outline: Qt.alpha(Theme.color("text", "#e4e4e7"), 0.05)
    readonly property color foreground: Theme.color("text", "#e4e4e7")
    readonly property color muted: Theme.color("textMuted", "#8b8b93")
    readonly property color secondary: Theme.color("secondaryLabel", "#a1a1aa")
    readonly property color iconMuted: Theme.color("iconMuted", "#8b8b93")
    readonly property color branchColor: Theme.color("branchForeground", Qt.alpha(muted, 0.7))
    readonly property var modelChoices: buildModelChoices(ready ? model.instances : [])
    readonly property var effortOption: ready ? (model.options.find(option => option.type === "select") ?? null) : null
    readonly property int maximumCardWidth: 768
    readonly property int gutter: 20

    // The last text this brick sent; an echo of it from the page is not an edit.
    property string lastSentText: ""
    property int lastSentCursor: -1

    implicitHeight: stack.implicitHeight + gutter
    color: canvas

    function buildModelChoices(instances) {
        const choices = [];
        for (const instance of instances) {
            for (const entry of instance.models) {
                choices.push({
                    label: instances.length > 1 ? instance.displayName + " · " + entry.name : entry.name,
                    instanceId: instance.instanceId,
                    slug: entry.slug,
                    disabledReason: entry.disabledReason
                });
            }
        }
        return choices;
    }

    function runtimeIcon(mode) {
        switch (mode) {
        case "approval-required":
            return "lock";
        case "auto-accept-edits":
            return "pen-line";
        case "auto":
            return "sparkles";
        default:
            return "lock-open";
        }
    }

    function flushText() {
        textDebounce.stop();
        if (input.text !== composer.lastSentText || input.cursorPosition !== composer.lastSentCursor) {
            composer.lastSentText = input.text;
            composer.lastSentCursor = input.cursorPosition;
            Shell.dispatch("composer.text.set", {
                text: input.text,
                cursor: input.cursorPosition
            });
        }
    }

    function selectSuggestion(index) {
        const item = composer.suggestions[index];
        if (!item) {
            return;
        }
        Shell.dispatch("composer.suggest.select", {
            id: item.id
        });
    }

    function attach(urls) {
        const files = Shell.readImageFiles(urls);
        if (files.length === 0) {
            return;
        }
        Shell.dispatch("composer.attach", {
            files: files
        });
    }

    function submit(intent) {
        if (!composer.ready) {
            return;
        }
        // canSend reflects the text the page has seen, which lags this input by
        // the debounce; with local text, let the page validate the send (it
        // echoes the prompt back if it declines).
        if (!composer.model.canSend && input.text.trim().length === 0) {
            return;
        }
        textDebounce.stop();
        const text = input.text;
        composer.lastSentText = "";
        input.text = "";
        Shell.dispatch("composer.submit", {
            text: text,
            intent: intent
        });
    }

    onPublishedTextChanged: {
        if (publishedText !== input.text && publishedText !== lastSentText) {
            input.text = publishedText;
            lastSentText = publishedText;
            // The page moved the caret (a suggestion was inserted, a send cleared
            // the prompt); follow it.
            input.cursorPosition = Math.min(publishedCursor, input.text.length);
            lastSentCursor = input.cursorPosition;
        }
    }

    onSuggestionsChanged: suggestionList.currentIndex = suggestions.length > 0 ? 0 : -1

    Timer {
        id: textDebounce

        interval: 120
        onTriggered: composer.flushText()
    }

    ColumnLayout {
        id: stack

        anchors.top: parent.top
        anchors.horizontalCenter: parent.horizontalCenter
        width: Math.min(parent.width - composer.gutter * 2, composer.maximumCardWidth)
        spacing: 0

        // @file, $skill and /command suggestions, computed by the page for the
        // caret it was last told about; they sit on the card's top edge.
        Rectangle {
            Layout.fillWidth: true
            Layout.leftMargin: 22
            Layout.rightMargin: 22
            visible: composer.suggesting
            implicitHeight: visible ? Math.min(suggestionList.contentHeight, 240) + 8 : 0
            topLeftRadius: 16
            topRightRadius: 16
            color: Theme.color("surfaceOverlay", "#18181b")
            border.color: composer.outline
            border.width: 1

            ListView {
                id: suggestionList

                anchors.fill: parent
                anchors.margins: 4
                clip: true
                boundsBehavior: Flickable.StopAtBounds
                model: composer.suggestions
                highlightMoveDuration: 0
                keyNavigationWraps: true

                delegate: Rectangle {
                    id: suggestion

                    required property var modelData
                    required property int index

                    width: ListView.view.width
                    height: 34
                    radius: 10
                    color: ListView.isCurrentItem ? Theme.color("accentSurface", "#2a2a30") : suggestionHover.hovered ? Theme.color("sidebarRowHover", "#1c1c21") : "transparent"

                    HoverHandler {
                        id: suggestionHover
                    }

                    TapHandler {
                        onTapped: {
                            composer.flushText();
                            composer.selectSuggestion(suggestion.index);
                        }
                    }

                    RowLayout {
                        anchors.fill: parent
                        anchors.leftMargin: 12
                        anchors.rightMargin: 12
                        spacing: 8

                        Text {
                            text: suggestion.modelData.label
                            color: composer.foreground
                            font.pixelSize: 12
                            font.weight: Font.Medium
                            font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                            elide: Text.ElideMiddle
                            Layout.maximumWidth: parent.width * 0.5
                        }

                        Text {
                            Layout.fillWidth: true
                            text: suggestion.modelData.description
                            color: composer.muted
                            font.pixelSize: 12
                            font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                            elide: Text.ElideMiddle
                        }
                    }
                }

                Text {
                    anchors.centerIn: parent
                    visible: suggestionList.count === 0
                    text: composer.ready && composer.model.suggestionsEmptyText ? composer.model.suggestionsEmptyText : ""
                    color: composer.muted
                    font.pixelSize: 12
                }
            }
        }

        // The glass card.
        Rectangle {
            id: card

            Layout.fillWidth: true
            implicitHeight: cardColumn.implicitHeight
            z: 1
            radius: 22
            color: Theme.color("surface", "#141416")
            border.color: composer.outline
            border.width: 1

            DropArea {
                anchors.fill: parent
                keys: ["text/uri-list"]
                onDropped: drop => {
                    if (drop.hasUrls) {
                        composer.attach(drop.urls);
                        drop.accept(Qt.CopyAction);
                    }
                }
            }

            ColumnLayout {
                id: cardColumn

                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                spacing: 0

                // Attached images and terminal selections living on the draft.
                Flow {
                    Layout.fillWidth: true
                    Layout.leftMargin: 16
                    Layout.rightMargin: 16
                    Layout.topMargin: 12
                    visible: composer.ready && (composer.model.attachments.length > 0 || composer.model.terminalContexts.length > 0)
                    spacing: 6

                    Repeater {
                        model: composer.ready ? composer.model.attachments : []

                        delegate: ShellButton {
                            required property var modelData

                            implicitHeight: 24
                            iconName: "image"
                            text: modelData.name
                            font.pixelSize: 12
                            Accessible.name: qsTr("Remove %1").arg(modelData.name)
                            onClicked: Shell.dispatch("composer.attachment.remove", {
                                id: modelData.id
                            })
                        }
                    }

                    Repeater {
                        model: composer.ready ? composer.model.terminalContexts : []

                        delegate: ShellButton {
                            required property var modelData

                            implicitHeight: 24
                            iconName: "terminal"
                            text: modelData.label + " " + modelData.lineStart + "–" + modelData.lineEnd
                            font.pixelSize: 12
                            Accessible.name: qsTr("Remove terminal selection %1").arg(modelData.label)
                            onClicked: Shell.dispatch("composer.terminalContext.remove", {
                                id: modelData.id
                            })
                        }
                    }
                }

                ScrollView {
                    Layout.fillWidth: true
                    Layout.leftMargin: 16
                    Layout.rightMargin: 16
                    Layout.topMargin: 16
                    Layout.bottomMargin: 8
                    Layout.preferredHeight: Math.min(Math.max(input.implicitHeight, 54), 184)
                    clip: true

                    TextArea {
                        id: input

                        padding: 0
                        enabled: composer.ready && !composer.model.editorDisabled
                        placeholderText: composer.ready ? composer.model.placeholder : qsTr("Open a thread to start")
                        placeholderTextColor: composer.muted
                        color: composer.foreground
                        wrapMode: TextEdit.Wrap
                        selectByMouse: true
                        background: null
                        font.pixelSize: 14
                        font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                        Accessible.name: qsTr("Message")
                        onTextChanged: {
                            if (text !== composer.lastSentText) {
                                textDebounce.restart();
                            }
                        }
                        Keys.onPressed: event => {
                            if (event.key !== Qt.Key_Return && event.key !== Qt.Key_Enter) {
                                return;
                            }
                            if (event.modifiers & Qt.ShiftModifier) {
                                return;
                            }
                            event.accepted = true;
                            composer.submit((event.modifiers & (Qt.ControlModifier | Qt.MetaModifier)) ? "background" : "foreground");
                        }
                    }
                }

                RowLayout {
                    Layout.fillWidth: true
                    Layout.leftMargin: 16
                    Layout.rightMargin: 16
                    Layout.bottomMargin: 16
                    spacing: 4

                    ShellButton {
                        subtle: true
                        iconName: "paperclip"
                        iconSize: 16
                        iconTint: composer.iconMuted
                        Layout.leftMargin: -10
                        enabled: composer.ready && !composer.model.editorDisabled
                        Accessible.name: qsTr("Attach image")
                        onClicked: imagePicker.open()

                        FileDialog {
                            id: imagePicker

                            title: qsTr("Attach images")
                            fileMode: FileDialog.OpenFiles
                            nameFilters: [qsTr("Images (*.png *.jpg *.jpeg *.gif *.webp *.heic *.heif)")]
                            onAccepted: composer.attach(selectedFiles)
                        }
                    }

                    ShellComboBox {
                        id: modelPicker

                        Layout.fillWidth: true
                        Layout.minimumWidth: 72
                        Layout.maximumWidth: Math.min(implicitWidth, 224)
                        iconName: "sparkles"
                        enabled: composer.ready && composer.modelChoices.length > 0
                        model: composer.modelChoices.map(choice => choice.label)
                        currentIndex: composer.ready ? composer.modelChoices.findIndex(choice => choice.instanceId === composer.model.selectedInstanceId && choice.slug === composer.model.selectedModel) : -1
                        displayText: currentIndex < 0 ? qsTr("Model") : currentText
                        Accessible.name: qsTr("Model")
                        onActivated: index => {
                            const choice = composer.modelChoices[index];
                            if (choice && choice.disabledReason === null) {
                                Shell.dispatch("composer.model.select", {
                                    instanceId: choice.instanceId,
                                    model: choice.slug
                                });
                            }
                        }
                    }

                    Separator {
                        visible: composer.effortOption !== null
                    }

                    ShellComboBox {
                        visible: composer.effortOption !== null
                        model: composer.effortOption ? composer.effortOption.choices.map(choice => choice.label) : []
                        currentIndex: composer.effortOption ? composer.effortOption.choices.findIndex(choice => choice.id === composer.effortOption.value) : -1
                        displayText: currentIndex < 0 ? (composer.effortOption ? composer.effortOption.label : "") : currentText
                        Accessible.name: composer.effortOption ? composer.effortOption.label : ""
                        onActivated: index => Shell.dispatch("composer.option.set", {
                                id: composer.effortOption.id,
                                value: composer.effortOption.choices[index].id
                            })
                    }

                    Separator {}

                    ShellComboBox {
                        iconName: composer.ready ? composer.runtimeIcon(composer.model.runtimeMode) : "lock"
                        enabled: composer.ready
                        model: composer.ready ? composer.model.runtimeModes.map(mode => mode.label) : []
                        currentIndex: composer.ready ? composer.model.runtimeModes.findIndex(mode => mode.value === composer.model.runtimeMode) : -1
                        Accessible.name: qsTr("Permissions")
                        onActivated: index => Shell.dispatch("composer.runtimeMode.set", {
                                mode: composer.model.runtimeModes[index].value
                            })
                    }

                    Separator {
                        visible: planToggle.visible
                    }

                    ShellButton {
                        id: planToggle

                        subtle: true
                        visible: composer.ready && composer.model.showInteractionModeToggle
                        checkable: true
                        checked: composer.ready && composer.model.interactionMode === "plan"
                        iconName: checked ? "pencil-ruler" : "bot"
                        iconSize: 16
                        iconTint: checked ? composer.foreground : composer.secondary
                        tint: checked ? composer.foreground : composer.secondary
                        text: checked ? qsTr("Plan") : qsTr("Build")
                        font.pixelSize: 14
                        leftPadding: 10
                        rightPadding: 10
                        onClicked: Shell.dispatch("composer.interactionMode.set", {
                            mode: checked ? "plan" : "default"
                        })
                    }

                    Item {
                        Layout.fillWidth: true
                    }

                    Text {
                        visible: composer.ready && composer.model.pendingApprovalCount > 0
                        text: composer.ready ? qsTr("%1 approval(s) waiting in the timeline").arg(composer.model.pendingApprovalCount) : ""
                        color: Theme.color("warning", "#e0af68")
                        font.pixelSize: 12
                        font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                    }

                    ShellButton {
                        visible: composer.ready && composer.model.showPlanFollowUpPrompt && input.text.trim().length === 0 && !primaryAction.stopMode
                        implicitHeight: 28
                        text: qsTr("Implement")
                        onClicked: composer.submit("foreground")
                    }

                    // Round send / stop.
                    AbstractButton {
                        id: primaryAction

                        readonly property bool stopMode: composer.ready && composer.model.isRunning && input.text.trim().length === 0

                        implicitWidth: 32
                        implicitHeight: 32
                        enabled: composer.ready && (stopMode || composer.model.canSend || input.text.trim().length > 0)
                        hoverEnabled: true
                        opacity: enabled ? 1 : 0.3
                        scale: down ? 0.97 : hovered ? 1.05 : 1
                        Accessible.role: Accessible.Button
                        Accessible.name: stopMode ? qsTr("Stop") : qsTr("Send")
                        onClicked: stopMode ? Shell.dispatch("composer.interrupt") : composer.submit("foreground")

                        Behavior on scale {
                            NumberAnimation {
                                duration: 120
                                easing.type: Easing.OutCubic
                            }
                        }

                        background: Rectangle {
                            radius: 16
                            color: primaryAction.stopMode ? Qt.alpha(Theme.color("error", "#ef4444"), 0.9) : Theme.color("messageAction", "#2563eb")

                            Behavior on color {
                                ColorAnimation {
                                    duration: 120
                                }
                            }
                        }

                        contentItem: Item {
                            ShellIcon {
                                anchors.centerIn: parent
                                visible: !primaryAction.stopMode
                                name: "arrow-up"
                                size: 16
                                strokeWidth: 2.5
                                color: Theme.color("messageActionForeground", "#ffffff")
                            }

                            Rectangle {
                                anchors.centerIn: parent
                                visible: primaryAction.stopMode
                                width: 11
                                height: 11
                                radius: 2
                                color: Theme.color("errorForeground", "#ffffff")
                            }
                        }
                    }
                }
            }
        }

        // Context strip: environment, checkout mode, PR, branch — welded under
        // the card and tucked 16px beneath it.
        Item {
            id: contextStrip

            readonly property var ws: composer.workspace
            readonly property bool wsReady: ws !== null
            readonly property string envModeIcon: !wsReady ? "folder" : ws.envMode === "worktree" ? "folder-git-2" : "folder-git"

            Layout.fillWidth: true
            Layout.leftMargin: 22
            Layout.rightMargin: 22
            Layout.topMargin: -16
            implicitHeight: 16 + 4 + 24 + 4
            visible: wsReady

            Rectangle {
                anchors.fill: parent
                bottomLeftRadius: 16
                bottomRightRadius: 16
                color: "transparent"
                border.color: composer.outline
                border.width: 1
            }

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 4
                anchors.rightMargin: 8
                anchors.topMargin: 20
                anchors.bottomMargin: 4
                spacing: 8

                ShellComboBox {
                    visible: contextStrip.wsReady && contextStrip.ws.environments.length > 1
                    implicitHeight: 24
                    leftPadding: 7 + iconSize + 6
                    rightPadding: 7 + chevronSize + 4
                    iconSize: 12
                    chevronSize: 12
                    font.pixelSize: 12
                    iconName: "monitor"
                    enabled: contextStrip.wsReady && contextStrip.ws.environmentChangeable
                    model: contextStrip.wsReady ? contextStrip.ws.environments.map(env => env.label) : []
                    currentIndex: contextStrip.wsReady ? contextStrip.ws.environments.findIndex(env => env.environmentId === contextStrip.ws.activeEnvironmentId) : -1
                    Accessible.name: qsTr("Environment")
                    onActivated: index => Shell.dispatch("workspace.environment.set", {
                            environmentId: contextStrip.ws.environments[index].environmentId
                        })
                }

                Separator {
                    visible: contextStrip.wsReady && contextStrip.ws.environments.length > 1
                    implicitHeight: 14
                }

                ShellComboBox {
                    visible: contextStrip.wsReady && contextStrip.ws.envModeChangeable
                    implicitHeight: 24
                    leftPadding: 7 + iconSize + 6
                    rightPadding: 7 + chevronSize + 4
                    iconSize: 12
                    chevronSize: 12
                    font.pixelSize: 12
                    iconName: contextStrip.envModeIcon
                    model: [qsTr("Current checkout"), qsTr("New worktree")]
                    currentIndex: contextStrip.wsReady && contextStrip.ws.envMode === "worktree" ? 1 : 0
                    Accessible.name: qsTr("Checkout mode")
                    onActivated: index => Shell.dispatch("workspace.envMode.set", {
                            mode: index === 1 ? "worktree" : "local"
                        })
                }

                RowLayout {
                    visible: contextStrip.wsReady && !contextStrip.ws.envModeChangeable
                    spacing: 6
                    Layout.leftMargin: 7

                    ShellIcon {
                        name: contextStrip.envModeIcon
                        size: 12
                        color: composer.iconMuted
                        Layout.alignment: Qt.AlignVCenter
                    }

                    Text {
                        text: contextStrip.wsReady ? contextStrip.ws.envModeLabel : ""
                        color: composer.secondary
                        font.pixelSize: 12
                        font.weight: Font.Medium
                        font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                    }
                }

                Item {
                    Layout.fillWidth: true
                }

                // PR badge.
                Rectangle {
                    readonly property var pr: contextStrip.wsReady && contextStrip.ws.git ? contextStrip.ws.git.pullRequest : null
                    readonly property color prColor: pr === null ? "transparent" : pr.state === "merged" ? Theme.color("info", "#a78bfa") : pr.state === "closed" ? Theme.color("error", "#f87171") : Theme.color("success", "#34d399")

                    visible: pr !== null && contextStrip.ws.canOpenPullRequest
                    implicitWidth: prLabel.implicitWidth + 8
                    implicitHeight: 18
                    radius: 4
                    color: Qt.alpha(prColor, 0.15)

                    HoverHandler {
                        cursorShape: Qt.PointingHandCursor
                    }

                    TapHandler {
                        onTapped: Shell.dispatch("workspace.openPullRequest")
                    }

                    Text {
                        id: prLabel

                        anchors.centerIn: parent
                        text: parent.pr ? "#" + parent.pr.number : ""
                        color: parent.prColor
                        font.pixelSize: 11
                        font.weight: Font.Medium
                        font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                    }
                }

                ShellButton {
                    id: branchButton

                    visible: contextStrip.wsReady && (contextStrip.ws.branch !== null || contextStrip.ws.branchChangeable)
                    enabled: contextStrip.wsReady && contextStrip.ws.branchChangeable && !contextStrip.ws.branchSwitchPending
                    subtle: true
                    implicitHeight: 24
                    leftPadding: 7
                    rightPadding: 7
                    Layout.maximumWidth: 240
                    iconName: "git-branch"
                    iconSize: 12
                    iconTint: Qt.alpha(composer.iconMuted, 0.7)
                    tint: branchButton.hovered ? Qt.alpha(composer.foreground, 0.8) : composer.branchColor
                    chevron: contextStrip.wsReady && contextStrip.ws.branchChangeable
                    chevronSize: 12
                    font.pixelSize: 12
                    text: contextStrip.wsReady ? (contextStrip.ws.branch ?? qsTr("Pick branch")) : ""
                    Accessible.name: qsTr("Switch branch")
                    onClicked: branchPicker.open()

                    Popup {
                        id: branchPicker

                        x: parent.width - width
                        y: -height - 4
                        width: 320
                        height: 360
                        padding: 4
                        onOpened: {
                            branchSearch.text = "";
                            branchSearch.forceActiveFocus();
                        }
                        onClosed: Shell.dispatch("workspace.branch.search", {
                            query: ""
                        })

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

                        background: Rectangle {
                            color: Theme.color("surfaceOverlay", "#18181b")
                            border.color: Qt.alpha(composer.foreground, 0.1)
                            radius: 10
                        }

                        ColumnLayout {
                            anchors.fill: parent
                            spacing: 4

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
                                    const exact = contextStrip.ws.branches.find(ref => ref.name === name);
                                    Shell.dispatch(exact ? "workspace.branch.select" : "workspace.branch.create", {
                                        name: name
                                    });
                                    branchPicker.close();
                                }

                                background: Rectangle {
                                    color: "transparent"

                                    Rectangle {
                                        anchors.left: parent.left
                                        anchors.right: parent.right
                                        anchors.bottom: parent.bottom
                                        height: 1
                                        color: Qt.alpha(composer.foreground, 0.08)
                                    }
                                }
                            }

                            ListView {
                                id: branchList

                                Layout.fillWidth: true
                                Layout.fillHeight: true
                                clip: true
                                boundsBehavior: Flickable.StopAtBounds
                                model: contextStrip.wsReady ? contextStrip.ws.branches : []

                                delegate: Rectangle {
                                    id: branchRow

                                    required property var modelData

                                    readonly property string badge: modelData.current ? qsTr("current") : modelData.isDefault ? qsTr("default") : modelData.isRemote ? qsTr("remote") : ""

                                    width: ListView.view.width
                                    height: 28
                                    radius: 6
                                    color: rowHover.hovered ? Theme.color("accentSurface", "#1c1c21") : "transparent"

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

                                    RowLayout {
                                        anchors.fill: parent
                                        anchors.leftMargin: 8
                                        anchors.rightMargin: 8
                                        spacing: 8

                                        Text {
                                            Layout.fillWidth: true
                                            text: branchRow.modelData.name
                                            color: branchRow.modelData.isRemote ? composer.muted : composer.foreground
                                            font.pixelSize: 13
                                            font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                                            elide: Text.ElideMiddle
                                        }

                                        Text {
                                            visible: branchRow.badge.length > 0
                                            text: branchRow.badge
                                            color: Qt.alpha(composer.muted, 0.45)
                                            font.pixelSize: 10
                                            font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                                        }
                                    }
                                }

                                Text {
                                    anchors.centerIn: parent
                                    visible: branchList.count === 0
                                    text: contextStrip.wsReady && contextStrip.ws.branchesLoading ? qsTr("Loading refs…") : qsTr("No matching refs — Enter creates one")
                                    color: composer.muted
                                    font.pixelSize: 12
                                }
                            }

                            Text {
                                Layout.fillWidth: true
                                Layout.leftMargin: 8
                                Layout.bottomMargin: 4
                                visible: contextStrip.wsReady && contextStrip.ws.branchesTotal > contextStrip.ws.branches.length
                                text: contextStrip.wsReady ? qsTr("Showing %1 of %2 refs — type to narrow").arg(contextStrip.ws.branches.length).arg(contextStrip.ws.branchesTotal) : ""
                                color: composer.muted
                                font.pixelSize: 11
                            }
                        }
                    }
                }
            }
        }
    }

    component Separator: Rectangle {
        implicitWidth: 1
        implicitHeight: 16
        Layout.alignment: Qt.AlignVCenter
        Layout.leftMargin: 2
        Layout.rightMargin: 2
        color: Theme.color("border", "#27272a")
    }
}
