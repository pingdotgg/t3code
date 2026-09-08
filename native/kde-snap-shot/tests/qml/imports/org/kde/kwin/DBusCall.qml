import QtQml

QtObject {
    id: request
    property string service
    property string path
    property string dbusInterface
    property string method
    property var arguments: []
    signal finished(var values)
    signal failed()
    function call() {
        if (method === "Next") Workspace.pending = this;
        else if (method === "unloadScript") {
            Workspace.unloads++;
            finished([true]);
        }
        else {
            const event = JSON.parse(request.arguments[0]);
            Workspace.events = Workspace.events.concat([event]);
            Workspace.received(event.event);
            finished([]);
        }
    }
}
