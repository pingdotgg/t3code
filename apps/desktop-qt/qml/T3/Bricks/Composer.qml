import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Dialogs
import QtQuick.Layouts
import T3.Shell

// The prompt: text input, model/effort/mode pickers, send/stop. Rendered from
// Shell.state.composer (see packages/contracts/src/shell.ts); every change is
// dispatched back and the web app remains the owner of drafts and sending.
Rectangle {
    id: composer

    readonly property var model: Shell.state.composer ?? null
    readonly property bool ready: model !== null && model.target !== null
    readonly property string publishedText: ready ? model.text : ""
    readonly property int publishedCursor: ready ? model.cursor : 0
    readonly property var suggestions: ready ? model.suggestions : []
    readonly property bool suggesting: ready && model.triggerKind !== null && (suggestions.length > 0 || model.suggestionsEmptyText !== null)
    readonly property color surface: Theme.color("surface", "#141416")
    readonly property color border: Theme.color("border", "#27272a")
    readonly property color foreground: Theme.color("text", "#e4e4e7")
    readonly property color muted: Theme.color("textMuted", "#8b8b93")
    readonly property color accent: Theme.color("accent", "#3b82f6")
    readonly property var modelChoices: buildModelChoices(ready ? model.instances : [])
    readonly property var effortOption: ready ? (model.options.find(option => option.type === "select") ?? null) : null

    // The last text this brick sent; an echo of it from the page is not an edit.
    property string lastSentText: ""

    implicitHeight: column.implicitHeight + 24
    color: Theme.color("chrome", "#0b0b0d")

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

    property int lastSentCursor: -1

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
        if (!composer.ready || !composer.model.canSend) {
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
        id: column

        anchors.fill: parent
        anchors.margins: 12
        spacing: 8

        // Attached images and terminal selections living on the draft.
        Flow {
            Layout.fillWidth: true
            visible: composer.ready && (composer.model.attachments.length > 0 || composer.model.terminalContexts.length > 0)
            spacing: 6

            Repeater {
                model: composer.ready ? composer.model.attachments : []

                delegate: ShellButton {
                    required property var modelData

                    text: "🖼 " + modelData.name + "  ✕"
                    font.pixelSize: 12
                    onClicked: Shell.dispatch("composer.attachment.remove", {
                        id: modelData.id
                    })
                }
            }

            Repeater {
                model: composer.ready ? composer.model.terminalContexts : []

                delegate: ShellButton {
                    required property var modelData

                    text: "▤ " + modelData.label + " " + modelData.lineStart + "–" + modelData.lineEnd + "  ✕"
                    font.pixelSize: 12
                    onClicked: Shell.dispatch("composer.terminalContext.remove", {
                        id: modelData.id
                    })
                }
            }
        }

        // @file, $skill and /command suggestions, computed by the page for the
        // caret it was last told about.
        Rectangle {
            Layout.fillWidth: true
            visible: composer.suggesting
            implicitHeight: visible ? Math.min(suggestionList.contentHeight, 240) + 8 : 0
            radius: 8
            color: Theme.color("surfaceOverlay", "#18181b")
            border.color: composer.border
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
                    radius: 6
                    color: ListView.isCurrentItem ? Theme.color("sidebarRowSelected", "#2a2a30") : suggestionHover.hovered ? Theme.color("sidebarRowHover", "#1c1c21") : "transparent"

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
                        anchors.leftMargin: 10
                        anchors.rightMargin: 10
                        spacing: 8

                        Text {
                            text: suggestion.modelData.label
                            color: composer.foreground
                            font.pixelSize: 13
                            elide: Text.ElideMiddle
                            Layout.maximumWidth: parent.width * 0.5
                        }

                        Text {
                            Layout.fillWidth: true
                            text: suggestion.modelData.description
                            color: composer.muted
                            font.pixelSize: 11
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

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: Math.min(Math.max(input.implicitHeight + 20, 64), 220)

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
            radius: Theme.radius
            color: Theme.color("input", "#141416")
            border.color: input.activeFocus ? Theme.color("focus", "#3b82f6") : composer.border
            border.width: 1

            ScrollView {
                anchors.fill: parent
                anchors.margins: 10

                TextArea {
                    id: input

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
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 6

            ShellButton {
                subtle: true
                text: "📎"
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

                Layout.preferredWidth: 220
                enabled: composer.ready && composer.modelChoices.length > 0
                model: composer.modelChoices.map(choice => choice.label)
                currentIndex: composer.ready ? composer.modelChoices.findIndex(choice => choice.instanceId === composer.model.selectedInstanceId && choice.slug === composer.model.selectedModel) : -1
                displayText: currentIndex < 0 ? qsTr("Model") : currentText
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

            ShellComboBox {
                Layout.preferredWidth: 130
                visible: composer.effortOption !== null
                model: composer.effortOption ? composer.effortOption.choices.map(choice => choice.label) : []
                currentIndex: composer.effortOption ? composer.effortOption.choices.findIndex(choice => choice.id === composer.effortOption.value) : -1
                displayText: currentIndex < 0 ? (composer.effortOption ? composer.effortOption.label : "") : currentText
                onActivated: index => Shell.dispatch("composer.option.set", {
                        id: composer.effortOption.id,
                        value: composer.effortOption.choices[index].id
                    })
            }

            ShellComboBox {
                Layout.preferredWidth: 160
                enabled: composer.ready
                model: composer.ready ? composer.model.runtimeModes.map(mode => mode.label) : []
                currentIndex: composer.ready ? composer.model.runtimeModes.findIndex(mode => mode.value === composer.model.runtimeMode) : -1
                onActivated: index => Shell.dispatch("composer.runtimeMode.set", {
                        mode: composer.model.runtimeModes[index].value
                    })
            }

            ShellButton {
                visible: composer.ready && composer.model.showInteractionModeToggle
                checkable: true
                checked: composer.ready && composer.model.interactionMode === "plan"
                text: checked ? qsTr("Plan") : qsTr("Build")
                onClicked: Shell.dispatch("composer.interactionMode.set", {
                    mode: checked ? "plan" : "default"
                })
            }

            Item {
                Layout.fillWidth: true
            }

            Label {
                visible: composer.ready && composer.model.pendingApprovalCount > 0
                text: composer.ready ? qsTr("%1 approval(s) waiting in the timeline").arg(composer.model.pendingApprovalCount) : ""
                color: Theme.color("warning", "#e0af68")
                font.pixelSize: 12
            }

            ShellButton {
                id: primaryAction

                readonly property bool stopMode: composer.ready && composer.model.isRunning && input.text.trim().length === 0

                enabled: composer.ready && (stopMode || composer.model.canSend)
                primary: !stopMode
                text: stopMode ? qsTr("Stop") : composer.ready && composer.model.showPlanFollowUpPrompt && input.text.trim().length === 0 ? qsTr("Implement") : qsTr("Send")
                onClicked: stopMode ? Shell.dispatch("composer.interrupt") : composer.submit("foreground")
            }
        }
    }
}
