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

        function test_echoPreservesEditStillWaitingForDebounce() {
            Shell.echoTextEdits = false;
            let composer = createTemporaryObject(composerComponent, root);
            verify(!!composer, "Component exists");
            let input = findChild(composer, "input");
            verify(!!input, "Object exists");
            input.focus = true;
            input.text = qsTr("Sent");
            composer.flushText();
            input.text = qsTr("Sent + local");
            input.cursorPosition = input.text.length;

            Shell.publishComposerText(qsTr("Sent"), 4, Shell.dispatchedActions[0].payload.edit);
            compare(input.text, qsTr("Sent + local"));
            compare(input.cursorPosition, 12);
            composer.flushText();
            compare(Shell.dispatchedActions[1].payload.text, qsTr("Sent + local"));
        }

        function test_coalescedEchoThenPageEdit() {
            Shell.echoTextEdits = false;
            let composer = createTemporaryObject(composerComponent, root);
            verify(!!composer, "Component exists");
            let input = findChild(composer, "input");
            verify(!!input, "Object exists");
            input.text = qsTr("First");
            composer.flushText();
            input.text = qsTr("Second");
            composer.flushText();
            input.cursorPosition = 2;

            Shell.publishComposerText(qsTr("Second"), 6, Shell.dispatchedActions[1].payload.edit);
            compare(input.text, qsTr("Second"));
            compare(input.cursorPosition, 2);
            // A later page edit may legitimately restore an earlier value.
            Shell.publishComposerText(qsTr("First"), 3);
            compare(input.text, qsTr("First"));
            compare(input.cursorPosition, 3);
        }

        function test_targetSwitchDiscardsOutstandingEchoes() {
            Shell.echoTextEdits = false;
            let composer = createTemporaryObject(composerComponent, root);
            verify(!!composer, "Component exists");
            let input = findChild(composer, "input");
            verify(!!input, "Object exists");
            input.text = qsTr("Thread A edit");
            composer.flushText();
            Shell.publishComposerTarget("thread-b", qsTr("Thread B draft"), 4);
            compare(input.text, qsTr("Thread B draft"));
            compare(input.cursorPosition, 4);
            Shell.publishComposerText(qsTr("Thread A edit"), 2);
            compare(input.text, qsTr("Thread A edit"));
            compare(input.cursorPosition, 2);
        }

        function test_repeatedTextDoesNotAcknowledgeAnOlderEdit() {
            Shell.echoTextEdits = false;
            let composer = createTemporaryObject(composerComponent, root);
            verify(!!composer, "Component exists");
            let input = findChild(composer, "input");
            verify(!!input, "Object exists");
            for (const text of ["First", "Second", "First"]) {
                input.text = text;
                composer.flushText();
            }
            input.cursorPosition = 2;

            Shell.publishComposerText("First", 5, Shell.dispatchedActions[0].payload.edit);
            Shell.publishComposerText("Second", 6, Shell.dispatchedActions[1].payload.edit);
            compare(input.text, "First");
            compare(input.cursorPosition, 2);
            Shell.publishComposerText("First", 5, Shell.dispatchedActions[2].payload.edit);
            Shell.publishComposerText("", 0);
            compare(input.text, "");
        }

        function test_coalescedEchoReturningToInitialText() {
            Shell.echoTextEdits = false;
            let composer = createTemporaryObject(composerComponent, root);
            verify(!!composer, "Component exists");
            let input = findChild(composer, "input");
            verify(!!input, "Object exists");
            input.text = "Temporary";
            composer.flushText();
            input.text = "";
            composer.flushText();

            Shell.publishComposerText("", 0, Shell.dispatchedActions[1].payload.edit);
            Shell.publishComposerText("Page replacement", 4);
            compare(input.text, "Page replacement");
            compare(input.cursorPosition, 4);
        }

        function test_legacyPageCanStillClearAfterSubmit() {
            let composer = createTemporaryObject(composerComponent, root);
            verify(!!composer, "Component exists");
            let input = findChild(composer, "input");
            verify(!!input, "Object exists");
            input.text = "Legacy draft";
            composer.submit("foreground");

            // Remove the field entirely, as pages predating revisions do.
            const state = JSON.parse(JSON.stringify(Shell.state));
            delete state.composer.edit;
            state.composer.text = "";
            state.composer.cursor = 0;
            Shell.state = state;
            compare(input.text, "");
        }

        function test_delayedEchoPreservesNewerTextAndSubmit() {
            Shell.echoTextEdits = false;
            let composer = createTemporaryObject(composerComponent, root);
            verify(!!composer, "Component exists");
            let input = findChild(composer, "input");
            verify(!!input, "Object exists");
            input.focus = true;
            input.text = qsTr("First edit");
            input.cursorPosition = input.text.length;
            composer.flushText();
            input.text = qsTr("First edit + 123");
            input.cursorPosition = input.text.length;
            composer.flushText();
            compare(Shell.dispatchCount, 2);

            Shell.publishComposerText(qsTr("First edit"), 10, Shell.dispatchedActions[0].payload.edit);
            compare(input.text, qsTr("First edit + 123"));
            compare(input.cursorPosition, 16);

            composer.submit("foreground");
            compare(Shell.dispatchedActions[2].payload.text, qsTr("First edit + 123"));
            Shell.publishComposerText(qsTr("First edit + 123"), 16, Shell.dispatchedActions[1].payload.edit);
            compare(input.text, qsTr("First edit + 123"));
            Shell.publishComposerText("", 0, Shell.dispatchedActions[2].payload.edit);
            compare(input.text, "");
        }
    }
}
