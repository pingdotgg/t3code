// Groups threads into project sections by their full project directory, matching the desktop
// sidebar: distinct threads stay distinct rows, subagents and side chats stay hidden.
function projectName(directory) {
  return String(directory || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
}
module.exports = function groups(threads) {
  var sections = [], byDirectory = Object.create(null);
  (threads || []).forEach(function (thread) {
    if (thread.relationshipToParent === 'subagent' || thread.sideChat === true) return;
    var key = String(thread.directory || '').replace(/[\\/]+$/, '');
    var section = byDirectory[key];
    if (!section) {
      section = byDirectory[key] = { title: projectName(key), threads: [] };
      sections.push(section);
    }
    section.threads.push(thread);
  });
  return sections;
};
