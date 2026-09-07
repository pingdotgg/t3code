import QtQuick
import QtTest
import "../qml/T3/Bricks"
import T3.Shell

Item {
    id: root
    width: 700
    height: 600
    Component { id: component; GitActions { width: 300; height: 32 } }
    TestCase {
        name: "GitActionsTests"
        when: windowShown
        function init() {
            Shell.reset();
            Shell.state = { git: {
                available: true, isRepo: true, busy: false, isDefaultRef: false,
                quickAction: { kind: "run_action", label: "Commit", disabledReason: null },
                files: [{ path: "a.txt", insertions: 1, deletions: 0 }],
                menu: [], hints: [], canPublish: false, pendingDefaultBranch: null
            } };
        }
        function cleanup() { Shell.reset(); }
        function test_emptySelectionDisablesBothCommitActions() {
            let git = createTemporaryObject(component, root);
            verify(!!git, "Component exists");
            let dialog = findChild(git, "commitDialog");
            verify(!!dialog, "Object exists");
            dialog.open();
            tryVerify(() => findChild(dialog.contentItem, "fileCheck-a.txt") !== null);
            let checkbox = findChild(dialog.contentItem, "fileCheck-a.txt");
            verify(!!checkbox, "Object exists");
            let commit = findChild(dialog.contentItem, "commitSelected");
            verify(!!commit, "Object exists");
            let branch = findChild(dialog.contentItem, "commitNewBranch");
            verify(!!branch, "Object exists");
            mouseClick(checkbox);
            tryCompare(commit, "enabled", false);
            tryCompare(branch, "enabled", false);
            mouseClick(checkbox);
            tryCompare(commit, "enabled", true);
            tryCompare(branch, "enabled", true);
            mouseClick(commit);
            tryCompare(Shell, "dispatchCount", 1);
            tryCompare(Shell.dispatchedActions[0], "action", "git.commit");
        }
    }
}
