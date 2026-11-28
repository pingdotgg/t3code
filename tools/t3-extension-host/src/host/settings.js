'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseJsonc } = require('../jsonc');

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function merge(base, value) {
  const result = clone(base);
  for (const [key, item] of Object.entries(value)) {
    result[key] = isPlainObject(result[key]) && isPlainObject(item) ? merge(result[key], item) : clone(item);
  }
  return result;
}

function defaultForType(type) {
  switch (Array.isArray(type) ? type[0] : type) {
    case 'boolean':
      return false;
    case 'integer':
    case 'number':
      return 0;
    case 'string':
      return '';
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return null;
  }
}

function setNested(target, keyPath, value) {
  const parts = keyPath.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
}

class SettingsStore {
  constructor({ vscodeSettingsPath, overridesPath, logger }) {
    this.vscodeSettingsPath = vscodeSettingsPath;
    this.overridesPath = overridesPath;
    this.logger = logger;
    this.defaults = {};
    this.user = {};
    this.overrides = {};
    this.mtimes = new Map();
    this.sections = new Map();
    this.reload();
  }

  addDefaults(packageJSON) {
    this.sections.clear();
    const sections = [].concat(packageJSON?.contributes?.configuration ?? []);
    for (const section of sections) {
      for (const [key, schema] of Object.entries(section?.properties ?? {})) {
        if (schema && 'default' in schema) this.defaults[key] = schema.default;
        else if (schema) this.defaults[key] = defaultForType(schema.type);
      }
    }
    for (const [key, value] of Object.entries(packageJSON?.contributes?.configurationDefaults ?? {})) {
      if (!key.startsWith('[')) this.defaults[key] = value;
    }
  }

  read(file) {
    try {
      this.mtimes.set(file, fs.statSync(file).mtimeMs);
      return parseJsonc(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger.warn(`Could not read ${file}: ${error.message}`);
      this.mtimes.set(file, 0);
      return {};
    }
  }

  reload() {
    this.sections.clear();
    this.user = this.read(this.vscodeSettingsPath);
    this.overrides = this.read(this.overridesPath);
  }

  changedOnDisk() {
    for (const file of [this.vscodeSettingsPath, this.overridesPath]) {
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {}
      if (mtime !== (this.mtimes.get(file) ?? 0)) return true;
    }
    return false;
  }

  get(key) {
    const layers = [this.defaults, this.user, this.overrides].filter((layer) => Object.hasOwn(layer, key)).map((layer) => layer[key]);
    if (layers.length) return layers.reduce((base, value) => (isPlainObject(base) && isPlainObject(value) ? merge(base, value) : clone(value)), undefined);
    const nested = this.section(key);
    return Object.keys(nested).length ? nested : undefined;
  }

  inspect(key) {
    const nestedDefaults = {};
    for (const [k, value] of Object.entries(this.defaults)) {
      if (k.startsWith(`${key}.`)) setNested(nestedDefaults, k.slice(key.length + 1), clone(value));
    }
    return {
      key,
      defaultValue: Object.hasOwn(this.defaults, key) ? clone(this.defaults[key]) : Object.keys(nestedDefaults).length ? nestedDefaults : undefined,
      globalValue: clone(Object.hasOwn(this.overrides, key) ? this.overrides[key] : this.user[key]),
    };
  }

  section(prefix = '') {
    let cached = this.sections.get(prefix);
    if (!cached) {
      if (this.sections.size >= 500) this.sections.clear();
      cached = this.buildSection(prefix);
      this.sections.set(prefix, cached);
    }
    return clone(cached);
  }

  buildSection(prefix) {
    const result = {};
    const keys = new Set([...Object.keys(this.defaults), ...Object.keys(this.user), ...Object.keys(this.overrides)]);
    for (const key of keys) {
      if (!prefix) setNested(result, key, this.get(key));
      else if (key.startsWith(`${prefix}.`)) setNested(result, key.slice(prefix.length + 1), this.get(key));
    }
    return result;
  }

  update(key, value) {
    this.sections.clear();
    if (value === undefined) delete this.overrides[key];
    else this.overrides[key] = clone(value);
    fs.mkdirSync(path.dirname(this.overridesPath), { recursive: true });
    fs.writeFileSync(this.overridesPath, `${JSON.stringify(this.overrides, null, 2)}\n`);
    this.mtimes.set(this.overridesPath, fs.statSync(this.overridesPath).mtimeMs);
  }
}

module.exports = { SettingsStore };
