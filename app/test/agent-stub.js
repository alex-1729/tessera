'use strict';
// A tiny stand-in for the agent service, for tests only (passed to src/main.js start() as `agentStub`).
// With it there is no Claude Code in the pane (it has no tools to offer): the window shows the cards area only.
// `inject` is the test hook: it emits an event (a sign-off request, a push request, a draft) as the real backend would.
// `send` is the UI-less call (window.api.agent.send); it answers canned phrases without any model call.
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = function makeStub({ emit }) {
  const log = [];
  const drafts = [];
  const calls = { send: [], confirm: [], decline: [], accept: [], discard: [] };
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
      if (/draft/i.test(text)) {
        const id = 'draft-' + (++seq);
        drafts.push({ id, kind: 'what_if', status: 'proposed', scope, summary: 'Here is what that would do.', at: new Date().toISOString(), items: [{ code: 'return 0' }] });
        push({ type: 'draft', scope, text: 'Here is what that would do.', draft: { id, kind: 'what_if', items: [{ code: 'return 0' }] } });
      } else push({ type: 'agent', scope, text: 'Answer to: ' + text });
      push({ type: 'done', scope });
      busy = false;
      return { ok: true };
    },
    drafts() { return drafts.map(d => ({ ...d })); },
    design() { return stub.agreedDesign || null; },   // the agreed design (design.json); a test sets stub.agreedDesign
    // a draft as the real backend would have saved it (the approval view reads drafts())
    addDraft(d) { drafts.push({ status: 'proposed', ...d }); },
    async acceptDraft(id) { calls.accept.push(id); await sleep(700); const d = drafts.find(x => x.id === id); if (d) d.status = 'accepted'; return { accepted: true }; },
    async discardDraft(id) { calls.discard.push(id); const d = drafts.find(x => x.id === id); if (d) d.status = 'discarded'; return { discarded: true }; },
    status() { return { busy: busy ? [{ scope: { level: 'model', id: 'model' } }] : [], cost_usd: 0 }; },
    // the request files: what each sign-off request came to
    requests() { return log.filter(e => e.type === 'signoff_request').map(e => ({ ...e.request, status: reqStatus[e.request.id] || 'pending', scope: e.scope, at: e.at, text: e.text, ...(reqWho[e.request.id] ? { reviewer: reqWho[e.request.id] } : {}) })); },
    async confirmSignoff(id, v) { calls.confirm.push({ id, ...v }); if (stub.refuse) return { signed: false, error: stub.refuse, request: { id, status: 'pending' } }; reqStatus[id] = 'confirmed'; reqWho[id] = v.reviewer; return { signed: true, text: 'Signed off.', request: { id, status: 'confirmed' } }; },
    async declineSignoff(id) { calls.decline.push(id); reqStatus[id] = 'declined'; return { declined: true, request: { id, status: 'declined' } }; },
  };
  return stub;
};
