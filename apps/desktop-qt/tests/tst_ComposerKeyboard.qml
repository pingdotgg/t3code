import QtQuick
import QtTest
import "../qml/T3/Bricks"
import T3.Shell

Item {
    id: root
    width: 900
    height: 700
    Component { id: component; Composer { width: 800; height: 650 } }
    TestCase {
        name: "ComposerKeyboardTests"
        when: windowShown
        function init() {
            Shell.reset();
            Shell.state = { composer: Object.assign({}, Shell.defaultComposer(), {
                triggerKind: "mention",
                suggestions: [{ id: "first", label: "First", description: "" }, { id: "second", label: "Second", description: "" }]
            }), workspace: null };
        }
        function cleanup() { Shell.reset(); }
        function test_selectSuggestion_data() {
            return [{ tag: "tab", key: Qt.Key_Tab }, { tag: "return", key: Qt.Key_Return }, { tag: "enter", key: Qt.Key_Enter }];
        }
        function test_selectSuggestion(data) {
            let composer = createTemporaryObject(component, root);
            verify(!!composer, "Component exists");
            let input = findChild(composer, "input");
            verify(!!input, "Object exists");
            input.focus = true;
            input.forceActiveFocus();
            keyClick(Qt.Key_Down);
            keyClick(data.key);
            compare(Shell.dispatchCount, 1);
            compare(Shell.dispatchedActions[0].action, "composer.suggest.select");
            compare(Shell.dispatchedActions[0].payload.id, "second");
        }
        function test_upWrapsAndEscapeDismissesWithoutSubmitting() {
            let composer = createTemporaryObject(component, root);
            verify(!!composer, "Component exists");
            let input = findChild(composer, "input");
            verify(!!input, "Object exists");
            input.focus = true;
            input.forceActiveFocus();
            keyClick(Qt.Key_Up);
            keyClick(Qt.Key_Tab);
            compare(Shell.dispatchedActions[0].payload.id, "second");
            keyClick(Qt.Key_Escape);
            compare(Shell.dispatchedActions[1].action, "composer.suggest.dismiss");
            compare(Shell.dispatchCount, 2);
        }
        function test_shiftEnterDoesNotChooseSuggestion() {
            let composer = createTemporaryObject(component, root);
            verify(!!composer, "Component exists");
            let input = findChild(composer, "input");
            verify(!!input, "Object exists");
            input.focus = true;
            input.forceActiveFocus();
            keyClick(Qt.Key_Return, Qt.ShiftModifier);
            compare(input.text, "\n");
            compare(Shell.dispatchCount, 0);
        }
    }
}
