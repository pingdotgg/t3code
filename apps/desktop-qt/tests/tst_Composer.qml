import QtQuick
import QtTest
import "../qml/T3/Bricks"
import T3.Shell

Item {
    id: root
    width: 900
    height: 700

    Component {
        id: composerComponent

        Composer {
            width: 800
            height: 650
        }
    }

    TestCase {
        name: "ComposerTests"
        when: windowShown

        function init() {
            Shell.reset();
        }

        function test_inputAcceptsText() {
            let composer = createTemporaryObject(composerComponent, root);
            verify(!!composer, "Component exists");
            let input = findChild(composer, "input");
            verify(!!input, "Object exists");
            input.focus = true;
            input.text = qsTr("Draft message");
            compare(input.text, qsTr("Draft message"));
            input.text = qsTr("12345");
            compare(input.text, qsTr("12345"));
            input.text = qsTr("Plan & review (v2)");
            compare(input.text, qsTr("Plan & review (v2)"));
        }

        function test_submitKeepsDraftUntilPageClearsIt() {
            let composer = createTemporaryObject(composerComponent, root);
            verify(!!composer, "Component exists");
            let input = findChild(composer, "input");
            verify(!!input, "Object exists");
            const draft = qsTr("Keep 123 & retry");
            input.focus = true;
            input.text = draft;
            tryCompare(composer, "publishedText", draft);

            composer.submit("foreground");

            compare(input.text, draft);
            compare(Shell.dispatchedActions[Shell.dispatchedActions.length - 1].action, "composer.submit");

            Shell.publishComposerText("", 0);
            tryCompare(input, "text", "");
        }

        function test_textDispatchIncludesTarget() {
            let composer = createTemporaryObject(composerComponent, root);
            verify(!!composer, "Component exists");
            let input = findChild(composer, "input");
            verify(!!input, "Object exists");

            input.text = qsTr("Scoped edit 123");

            tryCompare(Shell, "dispatchCount", 1);
            compare(Shell.dispatchedActions[0].action, "composer.text.set");
            compare(Shell.dispatchedActions[0].payload.target, "thread-a");
        }

        function test_targetSwitchDropsPendingDraftEdit() {
            let composer = createTemporaryObject(composerComponent, root);
            verify(!!composer, "Component exists");
            let input = findChild(composer, "input");
            verify(!!input, "Object exists");

            input.text = qsTr("Belongs to thread A");
            Shell.publishComposerTarget("thread-b", "", 0);

            wait(180);
            compare(Shell.dispatchCount, 0);
            compare(input.text, "");
        }
    }
}
