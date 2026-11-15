'use strict';
// A tiny stand-in for the agent service, for tests only (passed to src/main.js start() as `agentStub`).
// It keeps one conversation for the whole model, answers canned phrases without any model call, and lets a test
// inject events (a sign-off request, a question, a draft) as the real backend would emit them.
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = function makeStub({ emit }) {
  const log = [];
  const drafts = [];
  const old = [];           // earlier conversations: [{id, log}]
  const calls = { send: [], confirm: [], decline: [], accept: [], discard: [], interrupt: 0 };
  const reqStatus = {};      // request id -> pending (default) | confirmed | declined | expired | superseded
  const reqWho = {};
  let busy = false, seq = 0;
  const push = ev => { const e = { at: new Date(Date.now() + seq++).toISOString(), ...ev }; log.push(e); emit(e); return e; };

  const stub = {
    log, drafts, calls, reqStatus,
    inject: push,
    async send(scope, text, extra) {
      calls.send.push({ scope, text, extra });
      busy = true;
      push({ type: 'user', scope, text });
      await sleep(150);
      if (/question/i.test(text)) push({ type: 'question', scope, text: 'Which case should I use?', options: ['Base', 'High charge'] });
      else if (/draft/i.test(text)) {
        const id = 'draft-' + (++seq);
        drafts.push({ id, kind: 'what_if', status: 'proposed', scope, items: [{ code: 'return 0' }] });
        push({ type: 'draft', scope, text: 'Here is what that would do.', draft: { id, kind: 'what_if', items: [{ code: 'return 0' }] } });
      } else push({ type: 'agent', scope, text: 'Answer to: ' + text });
      push({ type: 'done', scope });
      busy = false;
      return { ok: true };
    },
    interrupt() { calls.interrupt++; return false; },
    // no argument: the whole conversation; a scope: only that selection's events
    history(scope) { if (!scope && stub.onlyScoped) throw new Error('Invalid scope.'); return scope ? log.filter(e => e.scope && e.scope.level === scope.level && e.scope.id === scope.id) : log.slice(); },
    drafts() { return drafts.map(d => ({ ...d })); },
    // conversations: the log on show plus earlier ones kept in memory
    conversations() { const sum = (id, l, current) => ({ id, current, title: (l.find(e => e.type === 'user') || l[0] || {}).text || 'Conversation', started: null, last: null, messages: l.filter(e => ['user', 'agent', 'question'].includes(e.type)).length });
      return (log.length ? [sum('current', log, true)] : []).concat(old.map(o => sum(o.id, o.log, false))); },
    newConversation() { if (log.length) old.unshift({ id: 'c2026111400000' + (old.length % 10) + '-abcdef', log: log.splice(0) }); return stub.conversations(); },
    openConversation(id) { const i = old.findIndex(o => o.id === id); if (i < 0) throw new Error('That conversation is no longer there.'); const o = old.splice(i, 1)[0]; stub.newConversation(); log.push(...o.log); return stub.conversations(); },
    deleteConversation(id) { if (id === 'current') log.length = 0; else { const i = old.findIndex(o => o.id === id); if (i >= 0) old.splice(i, 1); } return stub.conversations(); },
    async acceptDraft(id) { calls.accept.push(id); await sleep(700); const d = drafts.find(x => x.id === id); if (d) d.status = 'accepted'; return { accepted: true }; },
    async discardDraft(id) { calls.discard.push(id); const d = drafts.find(x => x.id === id); if (d) d.status = 'discarded'; return { discarded: true }; },
    async buildModule() { return { ok: true }; },
    status() { return { busy: busy ? [{ scope: { level: 'model', id: 'model' } }] : [], cost_usd: 0 }; },
    // the request files: what each sign-off request came to
    requests() { return log.filter(e => e.type === 'signoff_request').map(e => ({ ...e.request, status: reqStatus[e.request.id] || 'pending', scope: e.scope, at: e.at, ...(reqWho[e.request.id] ? { reviewer: reqWho[e.request.id] } : {}) })); },
    async confirmSignoff(id, v) { calls.confirm.push({ id, ...v }); if (stub.refuse) return { signed: false, error: stub.refuse, request: { id, status: 'pending' } }; reqStatus[id] = 'confirmed'; reqWho[id] = v.reviewer; return { signed: true, text: 'Signed off.', request: { id, status: 'confirmed' } }; },
    async declineSignoff(id) { calls.decline.push(id); reqStatus[id] = 'declined'; return { declined: true, request: { id, status: 'declined' } }; },
  };
  return stub;
};
