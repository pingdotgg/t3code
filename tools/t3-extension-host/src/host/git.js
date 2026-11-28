'use strict';

const { execFile } = require('node:child_process');
const { EventEmitter, Uri, noopEvent } = require('./types');

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim());
    });
  });
}

function parseRemotes(output) {
  const remotes = new Map();
  for (const line of (output ?? '').split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const [, name, url, kind] = match;
    const remote = remotes.get(name) ?? { name, isReadOnly: false };
    if (kind === 'fetch') remote.fetchUrl = url;
    else remote.pushUrl = url;
    remotes.set(name, remote);
  }
  return [...remotes.values()].sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : 0));
}

function createGitExtension() {
  const opened = new EventEmitter();
  const closed = new EventEmitter();
  let repository = null;
  let currentRoot = null;

  const api = {
    state: 'initialized',
    onDidChangeState: noopEvent,
    onDidPublish: noopEvent,
    onDidOpenRepository: opened.event,
    onDidCloseRepository: closed.event,
    git: { path: 'git' },
    get repositories() {
      return repository ? [repository] : [];
    },
    getRepository() {
      return repository;
    },
  };

  function replace(next) {
    const previous = repository;
    repository = next;
    if (previous) closed.fire(previous);
    if (next) opened.fire(next);
  }

  async function setRoot(root) {
    currentRoot = root;
    if (!root) {
      replace(null);
      return;
    }
    const top = await git(root, ['rev-parse', '--show-toplevel']);
    if (currentRoot !== root) return;
    if (!top) {
      replace(null);
      return;
    }
    const [branch, commit, remotes] = await Promise.all([
      git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(root, ['rev-parse', 'HEAD']),
      git(root, ['remote', '-v']),
    ]);
    if (currentRoot !== root) return;
    replace({
      rootUri: Uri.file(top),
      ui: { selected: true },
      inputBox: { value: '' },
      state: {
        HEAD: branch && branch !== 'HEAD' ? { type: 0, name: branch, commit } : { type: 0, commit },
        remotes: parseRemotes(remotes),
        refs: [],
        submodules: [],
        mergeChanges: [],
        indexChanges: [],
        workingTreeChanges: [],
        untrackedChanges: [],
        onDidChange: noopEvent,
      },
    });
  }

  const exports = { enabled: true, onDidChangeEnablement: noopEvent, getAPI: () => api };
  const extension = {
    id: 'vscode.git',
    extensionPath: '',
    extensionUri: Uri.file('/'),
    extensionKind: 1,
    isActive: true,
    packageJSON: { name: 'git', publisher: 'vscode', version: '1.0.0' },
    exports,
    activate: async () => exports,
  };

  return { extension, setRoot };
}

module.exports = { createGitExtension };
