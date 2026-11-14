const g = window.gridcraft;
const cmds = await g.commands();
const list = Array.isArray(cmds) ? cmds : (cmds.commands || cmds);
const s = JSON.stringify(list);
const fontCmds = (Array.isArray(list) ? list : []).filter(c => /font|autofit|width/i.test(JSON.stringify(c))).map(c => JSON.stringify(c).slice(0, 400));
let methods = null;
try { methods = await g.request('methods', {}); } catch (e) { methods = 'err ' + e.message; }
return { type: typeof cmds, n: Array.isArray(list) ? list.length : null, sample: s.slice(0, 600), fontCmds, methods: JSON.stringify(methods).slice(0, 1500), keys: Object.keys(g) };
