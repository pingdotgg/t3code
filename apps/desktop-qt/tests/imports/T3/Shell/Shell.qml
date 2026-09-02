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

    signal actionRequested(string action, var payload)

    function defaultComposer() {
        return {
            target: "thread-a",
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
        dispatchedActions = [];
        dispatchCount = 0;
        state = {
            composer: defaultComposer(),
            workspace: null
        };
    }

    function publishComposerText(text, cursor) {
        state = {
            composer: Object.assign({}, state.composer, {
                text: text,
                cursor: cursor
            }),
            workspace: state.workspace
        };
    }

    function publishComposerTarget(target, text, cursor) {
        state = {
            composer: Object.assign({}, state.composer, {
                target: target,
                text: text,
                cursor: cursor
            }),
            workspace: state.workspace
        };
    }

    function dispatch(action, payload) {
        dispatchedActions = dispatchedActions.concat([{
            action: action,
            payload: payload
        }]);
        dispatchCount += 1;
        if (action === "composer.text.set" && payload.target === state.composer.target) {
            publishComposerText(payload.text, payload.cursor);
        }
        actionRequested(action, payload);
    }

    function readImageFiles(urls) {
        return [];
    }
}
