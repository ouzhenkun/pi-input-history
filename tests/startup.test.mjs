import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-input-history-test-"));
after(() => rmSync(agentDir, { recursive: true, force: true }));

class Editor {
  text = "";
  cursor = 0;
  history = [];
  addToHistory(text) { this.history.unshift(text); }
}

const DEFAULT_MESSAGES = ["old prompt", "recent prompt"];
const EXPECTED_HISTORY = DEFAULT_MESSAGES.toReversed();

let listSessions;
const sessionEntries = new Map();
// Node 22.23.3 ignores mock.module's exports option; namedExports supports Node 22.
mock.module("@earendil-works/pi-coding-agent", {
  namedExports: {
    CustomEditor: Editor,
    getAgentDir: () => agentDir,
    SessionManager: {
      list: (...args) => listSessions(...args),
      open: (path) => ({ getEntries: () => sessionEntries.get(path) }),
    },
  },
});
mock.module("@earendil-works/pi-tui", {
  namedExports: {
    Input: class {},
    Key: {},
    matchesKey: () => false,
    truncateToWidth: (text) => text,
    visibleWidth: (text) => text.length,
  },
});
const { default: inputHistory } = await import("../index.ts");

function fixture(previousFactory) {
  const { promise, resolve, reject } = Promise.withResolvers();
  listSessions = () => promise;
  const handlers = new Map();
  inputHistory({
    on: (event, handler) => handlers.set(event, handler),
    registerShortcut: () => {},
  });
  const state = {
    editor: new Editor(),
    factory: previousFactory,
    view: undefined,
    focused: undefined,
    replacements: 0,
  };
  state.view = state.focused = state.editor;
  const ctx = {
    cwd: "/test-project",
    ui: {
      getEditorComponent: () => state.factory,
      setEditorComponent: (factory) => {
        state.replacements++;
        state.factory = factory;
        const draft = state.editor.text;
        state.editor = factory({}, {}, {});
        state.editor.text = draft;
        // Pi's setter dismisses selectors and focuses the replacement editor.
        state.view = state.focused = state.editor;
      },
    },
  };
  return {
    state,
    start: () => handlers.get("session_start")({}, ctx),
    openSelector: (selector = {}) => {
      state.view = state.focused = selector;
      return selector;
    },
    finish: (messages = DEFAULT_MESSAGES) => {
      const path = "/fake/session.jsonl";
      sessionEntries.set(path, messages.map((text) => ({
        type: "message", message: { role: "user", content: text },
      })));
      resolve(messages.length ? [{ path, modified: new Date(0) }] : []);
    },
    fail: () => reject(new Error("unavailable history")),
  };
}

test("history completion does not dismiss a model selector opened during startup", async () => {
  const f = fixture();
  const loading = f.start();
  const selector = f.openSelector({ query: "gpt", selectedIndex: 2 });
  f.finish();
  await loading;
  assert.equal(f.state.view, selector);
  assert.equal(f.state.focused, selector);
  assert.equal(selector.query, "gpt");
  assert.equal(selector.selectedIndex, 2);
});

test("install once before loading, then seed the same editor without resetting its draft", async () => {
  const f = fixture();
  const loading = f.start();
  assert.equal(f.state.replacements, 1);
  const editor = f.state.editor;
  editor.text = "partly typed draft";
  editor.cursor = 6;
  f.finish();
  await loading;
  assert.equal(f.state.replacements, 1);
  assert.equal(f.state.editor, editor);
  assert.equal(editor.text, "partly typed draft");
  assert.equal(editor.cursor, 6);
  assert.deepEqual(editor.history, EXPECTED_HISTORY);
});

test("preserve another extension's editor factory and seed later instances", async () => {
  const customEditor = new Editor();
  customEditor.marker = "custom editor";
  const create = mock.fn(() => customEditor);
  const f = fixture(create);
  const loading = f.start();
  assert.equal(f.state.editor, customEditor);
  f.finish();
  await loading;
  assert.equal(f.state.editor.marker, "custom editor");
  assert.equal(create.mock.callCount(), 1);
  assert.deepEqual(customEditor.history, EXPECTED_HISTORY);

  // A later factory invocation must seed its new editor from the loaded cache.
  create.mock.mockImplementation(() => new Editor());
  const nextEditor = f.state.factory({}, {}, {});
  assert.deepEqual(nextEditor.history, EXPECTED_HISTORY);
});

for (const outcome of ["empty", "failed"]) {
  test(`${outcome} history leaves an open selector and the editor unchanged`, async () => {
    const f = fixture();
    const loading = f.start();
    const editor = f.state.editor;
    const selector = f.openSelector();
    if (outcome === "failed") f.fail();
    else f.finish([]);
    await loading;
    assert.equal(f.state.view, selector);
    assert.equal(f.state.focused, selector);
    assert.equal(f.state.editor, editor);
    assert.deepEqual(editor.history, []);
  });
}

test("only the latest editor instance is seeded when loading finishes", async () => {
  const f = fixture();
  const loading = f.start();
  const firstEditor = f.state.editor;
  const nextEditor = f.state.factory({}, {}, {});
  f.finish();
  await loading;
  assert.deepEqual(firstEditor.history, []);
  assert.deepEqual(nextEditor.history, EXPECTED_HISTORY);
});

test("an editor without addToHistory remains supported", async () => {
  const customEditor = { text: "custom draft" };
  const f = fixture(() => customEditor);
  const loading = f.start();
  f.finish();
  await loading;
  assert.equal(f.state.editor, customEditor);
});
