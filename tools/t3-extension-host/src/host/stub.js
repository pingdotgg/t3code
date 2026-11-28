'use strict';

const { Disposable, noopEvent } = require('./types');

const reported = new Set();
let reporter = () => {};

function setMissingReporter(fn) {
  reporter = fn;
}

function missingApis() {
  return [...reported];
}

function note(name) {
  if (reported.has(name)) return;
  reported.add(name);
  reporter(name, new Error().stack);
}

const settled = () => Promise.resolve(undefined);

// Stands in for any API the host doesn't implement: callable, constructible, assignable and awaitable,
// so extensions keep running instead of throwing. Calls into it are reported once per API name.
function stub(name, { report = true, thenable = false } = {}) {
  const values = new Map();
  const children = new Map();
  const target = function () {};
  return new Proxy(target, {
    get(_, prop) {
      if (values.has(prop)) return values.get(prop);
      if (typeof prop === 'symbol') {
        if (prop === Symbol.iterator) return function* () {};
        if (prop === Symbol.asyncIterator) return async function* () {};
        if (prop === Symbol.toPrimitive) return () => '';
        return undefined;
      }
      if (prop === 'then') return thenable ? (ok, fail) => settled().then(ok, fail) : undefined;
      if (thenable && (prop === 'catch' || prop === 'finally')) return (fn) => settled()[prop](fn);
      if (prop === 'dispose') return () => {};
      if (prop === 'toString' || prop === 'toJSON' || prop === 'valueOf') return () => '';
      if (prop === 'length') return 0;
      if (/^on(Did|Will)[A-Z]/.test(prop)) return noopEvent;
      if (!children.has(prop)) children.set(prop, stub(`${name}.${prop}`, { report }));
      return children.get(prop);
    },
    set(_, prop, value) {
      values.set(prop, value);
      return true;
    },
    has(_, prop) {
      return values.has(prop) || Reflect.has(target, prop);
    },
    deleteProperty(_, prop) {
      values.delete(prop);
      return true;
    },
    apply() {
      if (report) note(name);
      const method = name.slice(name.lastIndexOf('.') + 1);
      if (/^register[A-Z]/.test(method)) return new Disposable(() => {});
      return stub(`${name}()`, { report: false, thenable: !/^create[A-Z]/.test(method) });
    },
    construct() {
      if (report) note(`new ${name}`);
      return stub(`new ${name}`, { report: false });
    },
  });
}

function namespace(target, name) {
  const stubs = new Map();
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === 'symbol' || prop === 'then' || prop in obj) return Reflect.get(obj, prop, receiver);
      if (/^on(Did|Will)[A-Z]/.test(prop)) return noopEvent;
      if (!stubs.has(prop)) stubs.set(prop, stub(name ? `${name}.${prop}` : prop));
      return stubs.get(prop);
    },
  });
}

module.exports = { missingApis, namespace, setMissingReporter, stub };
