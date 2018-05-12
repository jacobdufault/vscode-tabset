'use strict';

import * as vscode from 'vscode';

class Tab {
  constructor(
      readonly uri: vscode.Uri, readonly position: vscode.Position,
      readonly viewColumn?: vscode.ViewColumn) {}

  static fromEditor(editor: vscode.TextEditor): Tab {
    return new Tab(
        editor.document.uri, editor.selection.active, editor.viewColumn);
  }

  static parse(json: string): Tab {
    let obj = JSON.parse(json);
    return new Tab(
        vscode.Uri.parse(obj.uri),
        new vscode.Position(obj.position.line, obj.position.character),
        <vscode.ViewColumn>(obj.viewColumn));
  }

  stringify(): string {
    return JSON.stringify({
      uri: this.uri.toString(),
      position: this.position,
      viewColumn: this.viewColumn
    });
  }
}

class TabSet {
  active: boolean = false
  tabs: Tab[] = [];
  constructor(public name: string) {}

  static parse(json: string): TabSet {
    let obj = JSON.parse(json);
    let result = new TabSet(obj.name);
    result.active = obj.active;
    for (let tab of obj.tabs)
      result.tabs.push(Tab.parse(tab));
    return result;
  }

  stringify(): string {
    return JSON.stringify({
      name: this.name,
      active: this.active,
      tabs: this.tabs.map(t => t.stringify())
    });
  }
}

class TabManager {
  tabs: TabSet[] = [];

  constructor(readonly storage: vscode.Memento) {
    let serializedTabSets = JSON.parse(storage.get('tabs', '[]'));
    for (let serializedTabSet of serializedTabSets)
      this.tabs.push(TabSet.parse(serializedTabSet));
    if (this.tabs.length == 0) {
      let ts = new TabSet('0')
      ts.active = true;
      this.tabs.push(ts);
    }
  }

  allButActive(): TabSet[] {
    let result = [];
    for (let ts of this.tabs) {
      if (!ts.active)
        result.push(ts);
    }
    return result;
  }

  flush() {
    let serializedTabSets = [];
    for (let tabSet of this.tabs)
      serializedTabSets.push(tabSet.stringify());
    this.storage.update('tabs', JSON.stringify(serializedTabSets));
    updateStatusItem();
  }

  findActive(): TabSet {
    for (let ts of this.tabs) {
      if (ts.active)
        return ts;
    }
    throw new Error(
        'No active tabset - internal error. Please reset and file a bug with ' +
        'how to reproduce.');
  }

  async activate(ts: TabSet) {
    // Always close all tabs, otherwise there will be duplicate tabs on startup.
    let activeTabs = await saveAndCloseTabs();

    // Save state to active.
    let previous = this.findActive();
    previous.tabs = activeTabs;
    previous.active = false;
    ts.active = true;
    this.flush();

    // Switch tabs.
    for (let tab of ts.tabs) {
      try {
        await vscode.window.showTextDocument(tab.uri);
      } catch (error) {
        // Do not wait for the message to close.
        vscode.window.showErrorMessage(error);
      }
    }
  }
}

// Close the active editor, and try to wait for it to actually close.
async function closeActiveEditor() {
  const kTimeoutMs = 200;

  return new Promise(async resolve => {
    let doResolve = () => {
      disposable.dispose();
      clearTimeout(timeout);
      resolve();
    };

    // use var to hoist declaration to top of function so doResolve can access
    var timeout = setTimeout(doResolve, kTimeoutMs);
    var disposable = vscode.window.onDidChangeActiveTextEditor(e => {
      // After closing the active editor, onDidChangeActiveTextEditor will
      // immediately be called with null; it will be called once again after the
      // real editor is available. Ignore the result if it is undefined; if
      // undefined is the real result, it will be caught by the timeout.
      if (e)
        doResolve()
    });

    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
}

// Saves all tabs while also closing them.
//
// It'd be great to support saving without closing, but this ends up being a
// much more complicated problem due to vscode API limitations; see
// https://github.com/Microsoft/vscode/issues/15178.
async function saveAndCloseTabs(): Promise<Tab[]> {
  // TODO: use focus third/second/first editor group
  let result: Tab[] = [];
  while (vscode.window.activeTextEditor ||
         vscode.window.visibleTextEditors.length > 0) {
    let editor = vscode.window.activeTextEditor;
    if (editor)
      result.push(Tab.fromEditor(editor));
    await closeActiveEditor();
  }
  return result;
}

class QuickPickItem implements vscode.QuickPickItem {
  label: string;
  description?: string|undefined;
  detail?: string|undefined;
  picked?: boolean|undefined;

  constructor(readonly tab: TabSet) {
    this.label = tab.name;
    this.description = `${tab.tabs.length} tabs`
  }
}

async function tabsetSwitch() {
  let selected: QuickPickItem|undefined = await vscode.window.showQuickPick(
      tabManager.allButActive().map(_ => new QuickPickItem(_)));
  if (!selected)
    return;

  await tabManager.activate(selected.tab);
  tabManager.flush();
}

async function tabsetNew() {
  let name: string|undefined = await vscode.window.showInputBox(
      {prompt: 'Name', value: '' + tabManager.tabs.length});
  if (!name)
    return;

  let toLoad = new TabSet(name);
  tabManager.tabs.push(toLoad);
  await tabManager.activate(toLoad);
  tabManager.flush();
}

async function tabsetDelete() {
  if (tabManager.tabs.length <= 1) {
    vscode.window.showErrorMessage('Cannot delete only tabset');
    return;
  }

  let selected: QuickPickItem[]|undefined = await vscode.window.showQuickPick(
      tabManager.allButActive().map(_ => new QuickPickItem(_)),
      {canPickMany: true});
  if (!selected)
    return;

  function shouldKeep(t: TabSet): boolean {
    // Silence a compiler warning.
    if (!selected)
      return true;

    for (let s of selected) {
      if (s.tab.active && s.tab == t) {
        // This should not be possible to reach.
        throw new Error('Active tab cannot be deleted');
      }

      if (s.tab == t)
        return false;
    }
    return true;
  }
  tabManager.tabs = tabManager.tabs.filter(shouldKeep);
  tabManager.flush();
}

async function tabsetRename() {
  let name: string|undefined = await vscode.window.showInputBox(
      {prompt: 'Name', value: tabManager.findActive().name});
  if (!name)
    return;

  tabManager.findActive().name = name;
  tabManager.flush();
}

async function tabsetReset() {
  let result = await vscode.window.showWarningMessage(
      'Are you sure you want to reset all state?', 'Yes', 'No');
  if (result != 'Yes')
    return;

  tabManager.tabs = [];
  tabManager.flush();
  tabManager = new TabManager(tabManager.storage);
}

async function tabsetIconClick() {
  class Entry implements vscode.QuickPickItem {
    constructor(
        readonly command: string, readonly label: string,
        readonly description: string) {}
  }

  let selected = await vscode.window.showQuickPick([
    new Entry('tabset.switch', 'Switch', 'Switch to a different tabset'),
    new Entry('tabset.new', 'New', 'Create a new tabset'),
    new Entry('tabset.delete', 'Delete', 'Select other tabsets to delete'),
    new Entry('tabset.rename', 'Rename', 'Rename the current tabset'),
    new Entry('tabset.reset', 'Reset', 'Reset all state'),
  ]);
  if (selected)
    await vscode.commands.executeCommand(selected.command);
}

// All global variables
let tabManager: TabManager
let statusItem: vscode.StatusBarItem;

function updateStatusItem() {
  statusItem.text = `$(file-submodule) ${tabManager.findActive().name}`;
  statusItem.tooltip = `${tabManager.tabs.length - 1} other tabsets`
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Storing state to ' + context.storagePath);
  tabManager = new TabManager(context.workspaceState);

  // Create status item.
  context.subscriptions.push(
      statusItem =
          vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5));
  statusItem.command = 'tabset.iconClick';
  statusItem.show();
  updateStatusItem();

  // Register commands.
  function register(command: string, callback: (...args: any[]) => any) {
    context.subscriptions.push(
        vscode.commands.registerCommand(command, callback));
  }
  register('tabset.switch', tabsetSwitch);
  register('tabset.new', tabsetNew);
  register('tabset.delete', tabsetDelete);
  register('tabset.rename', tabsetRename);
  register('tabset.reset', tabsetReset);
  register('tabset.iconClick', tabsetIconClick);
}