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
  send: (scope, text, extra) => call('agent:send', scope, String(text), extra),
  interrupt: scope => call('agent:interrupt', scope),
  history: scope => call('agent:history', scope),
  drafts: () => call('agent:drafts'),
  acceptDraft: id => call('agent:acceptDraft', String(id)),
  discardDraft: id => call('agent:discardDraft', String(id)),
  buildModule: id => call('agent:buildModule', String(id)),
  status: () => call('agent:status'),
  onEvent: callback => {
    const h = (_e, ev) => callback(ev);
    ipcRenderer.on('agent:event', h);
    return () => ipcRenderer.removeListener('agent:event', h);
  },
} : null;

contextBridge.exposeInMainWorld('api', {
  ...(agentApi ? { agent: agentApi } : {}),
  tk: (command, args) => call('tk', String(command), args === undefined ? [] : args),
  readWorkbook: async relPath => new Uint8Array(await call('readWorkbook', String(relPath))),
  writeWorkbook: (relPath, bytes) => call('writeWorkbook', String(relPath), new Uint8Array(bytes)),
  reviewer: () => call('reviewer'),
  exportWorkbook: () => call('exportWorkbook'),
  lastErrorDetail: () => lastDetail,
  pickCsv: () => call('pickCsv'),
  // settings (View menu): {showRibbon, showFormulaBar}
  settings: () => call('settings'),
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
