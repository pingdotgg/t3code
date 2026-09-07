pragma Singleton
import QtQuick

QtObject {
    id: shell

    property var state: ({
            composer: defaultComposer(),
            workspace: null
        })
    property var dispatchedActions: []
    property int dispatchCount: 0
    property bool echoTextEdits: true

    signal actionRequested(string action, var payload)

    function defaultComposer() {
        return {
            target: "thread-a",
            edit: null,
            text: "",
            cursor: 0,
            suggestions: [],
            triggerKind: null,
            suggestionsEmptyText: null,
            instances: [],
            options: [],
            attachments: [],
            terminalContexts: [],
            placeholder: qsTr("Send a message"),
            editorDisabled: false,
            canSend: true,
            selectedInstanceId: null,
            selectedModel: null,
            runtimeMode: "approval-required",
            runtimeModes: [],
            showInteractionModeToggle: false,
            interactionMode: "default",
            pendingApprovalCount: 0,
            showPlanFollowUpPrompt: false,
            isRunning: false
        };
    }

    function reset() {
        echoTextEdits = true;
        dispatchedActions = [];
        dispatchCount = 0;
        state = {
            composer: defaultComposer(),
            workspace: null
        };
    }

    function publishComposerText(text, cursor, edit = state.composer.edit) {
        state = {
            composer: Object.assign({}, state.composer, {
                text: text,
                edit: edit,
                cursor: cursor
            }),
            workspace: state.workspace
        };
    }

    function publishComposerTarget(target, text, cursor) {
        state = {
            composer: Object.assign({}, state.composer, {
                target: target,
                edit: null,
                text: text,
                cursor: cursor
            }),
            workspace: state.workspace
        };
    }

    function dispatch(action, payload) {
        dispatchedActions = dispatchedActions.concat([
            {
                action: action,
                payload: payload
            }
        ]);
        dispatchCount += 1;
        if (echoTextEdits && action === "composer.text.set" && payload.target === state.composer.target) {
            publishComposerText(payload.text, payload.cursor, payload.edit);
        } else if (action === "composer.submit") {
            publishComposerText(payload.text, state.composer.cursor, payload.edit);
        }
        actionRequested(action, payload);
    }

    function readImageFiles(urls) {
        return [];
    }
}
