'use strict';
const { contextBridge, ipcRenderer } = require('electron');

let lastDetail = null;   // custom properties of an Error do not cross the context bridge
async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) { lastDetail = r.detail === undefined ? null : r.detail; throw new Error(r.error); }
  return r.value;
}

// The agent API exists only when main created the service (not in fixture mode).
const hasAgent = ipcRenderer.sendSync('agent:available') === true;
const agentApi = hasAgent ? {
  // UI-less: nothing in the window sends through this (messages are typed into Claude Code in the pane); tests do
  send: (scope, text, extra) => call('agent:send', scope, String(text), extra),
  drafts: () => call('agent:drafts'),
  requests: () => call('agent:requests'),
  design: () => call('agent:design'),
  acceptDraft: id => call('agent:acceptDraft', String(id)),
  discardDraft: id => call('agent:discardDraft', String(id)),
  status: () => call('agent:status'),
  confirmSignoff: (id, values) => call('agent:confirmSignoff', String(id), values),
  declineSignoff: id => call('agent:declineSignoff', String(id)),
  confirmPush: id => call('agent:confirmPush', String(id)),
  declinePush: id => call('agent:declinePush', String(id)),
  onEvent: callback => {
    const h = (_e, ev) => callback(ev);
    ipcRenderer.on('agent:event', h);
    return () => ipcRenderer.removeListener('agent:event', h);
  },
} : null;

contextBridge.exposeInMainWorld('api', {
  ...(agentApi ? { agent: agentApi } : {}),
  // Claude Code in the chat pane (present only when the app runs it): start({cols, rows}), input(text), resize, the
  // selection the next message is about, and its output.
  ...(agentApi && ipcRenderer.sendSync('term:available') === true ? { term: {
    start: size => call('term:start', size),
    restart: () => call('term:restart'),
    input: data => ipcRenderer.send('term:input', String(data)),
    resize: size => ipcRenderer.send('term:resize', size),
    select: scope => call('term:select', scope),
    sessions: () => call('term:sessions'),
    openSession: id => call('term:openSession', String(id)),
    deleteSession: id => call('term:deleteSession', String(id)),
    onData: callback => { const h = (_e, d) => callback(d); ipcRenderer.on('term:data', h); return () => ipcRenderer.removeListener('term:data', h); },
    onExit: callback => { const h = (_e, d) => callback(d); ipcRenderer.on('term:exit', h); return () => ipcRenderer.removeListener('term:exit', h); },
  } } : {}),
  tk: (command, args) => call('tk', String(command), args === undefined ? [] : args),
  readWorkbook: async relPath => new Uint8Array(await call('readWorkbook', String(relPath))),
  writeWorkbook: (relPath, bytes) => call('writeWorkbook', String(relPath), new Uint8Array(bytes)),
  reviewer: () => call('reviewer'),
  exportWorkbook: () => call('exportWorkbook'),
  lastErrorDetail: () => lastDetail,
  pickCsv: () => call('pickCsv'),
  // settings (View menu): {showRibbon, showFormulaBar}
  settings: () => call('settings'),
  setSetting: (key, value) => call('setSetting', String(key), value),
  readModelFile: relPath => call('readModelFile', String(relPath)),
  pickFolder: () => call('pickFolder'),
  launch: {
    checkLink: text => call('launch:checkLink', String(text)),
    list: () => call('launch:list'),
    current: () => call('launch:current'),
    git: id => call('launch:git', String(id)),
    review: id => call('launch:review', String(id)),
    open: id => call('launch:open', String(id)),
    remove: id => call('launch:remove', String(id)),
    openLink: id => call('launch:openLink', String(id)),
    setSettings: (id, values) => call('launch:setSettings', String(id), values),
    addFolder: () => call('launch:addFolder'),
    newModel: values => call('launch:new', values),
    github: () => call('launch:github'),
    checkRepoName: text => call('launch:checkRepoName', String(text)),
    commitInfo: id => call('launch:commitInfo', String(id)),
    commit: (id, message, push) => call('launch:commit', String(id), String(message || ''), !!push),
    onProgress: callback => {
      const h = (_e, line) => callback(String(line));
      ipcRenderer.on('launch:progress', h);
      return () => ipcRenderer.removeListener('launch:progress', h);
    },
  },
  onMenu: callback => {
    const h = (_e, a) => callback(String(a));
    ipcRenderer.on('menu', h);
    return () => ipcRenderer.removeListener('menu', h);
  },
  syncBars: bars => call('syncBars', bars),
  onSettings: callback => {
    const h = (_e, s) => callback(s);
    ipcRenderer.on('settings', h);
    return () => ipcRenderer.removeListener('settings', h);
  },
  onChanged: callback => {
    const h = () => callback();
    ipcRenderer.on('changed', h);
    return () => ipcRenderer.removeListener('changed', h);
  },
});
