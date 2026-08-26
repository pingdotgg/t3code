import QtQuick
import QtQuick.Controls.Basic
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

    function flushText() {
        textDebounce.stop();
        if (input.text !== composer.lastSentText) {
            composer.lastSentText = input.text;
            Shell.dispatch("composer.text.set", {
                text: input.text
            });
        }
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
        }
    }

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

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: Math.min(Math.max(input.implicitHeight + 20, 64), 220)
            radius: 10
            color: composer.surface
            border.color: input.activeFocus ? composer.accent : composer.border
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

            ComboBox {
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

            ComboBox {
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

            ComboBox {
                Layout.preferredWidth: 160
                enabled: composer.ready
                model: composer.ready ? composer.model.runtimeModes.map(mode => mode.label) : []
                currentIndex: composer.ready ? composer.model.runtimeModes.findIndex(mode => mode.value === composer.model.runtimeMode) : -1
                onActivated: index => Shell.dispatch("composer.runtimeMode.set", {
                        mode: composer.model.runtimeModes[index].value
                    })
            }

            Button {
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

            Button {
                id: primaryAction

                readonly property bool stopMode: composer.ready && composer.model.isRunning && input.text.trim().length === 0

                enabled: composer.ready && (stopMode || composer.model.canSend)
                highlighted: !stopMode
                text: stopMode ? qsTr("Stop") : composer.ready && composer.model.showPlanFollowUpPrompt && input.text.trim().length === 0 ? qsTr("Implement") : qsTr("Send")
                onClicked: stopMode ? Shell.dispatch("composer.interrupt") : composer.submit("foreground")
            }
        }
    }
}
