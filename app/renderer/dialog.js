import { h } from './util.js';

// Plain modal. opts: {title, sections:[Node], assumptions:[string], blockers:[string], reviewer, onConfirm(reviewer, comment)}
export function signoffDialog(opts) {
  return new Promise(resolve => {
    const overlay = h('div', { id: 'overlay' });
    const close = result => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(result); };
    const onKey = e => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);

    const blocked = opts.blockers && opts.blockers.length > 0;
    const boxes = (opts.assumptions || []).map(text => h('input', { type: 'checkbox' }));
    const reviewer = h('input', { type: 'text', id: 'reviewer', value: opts.reviewer || '' });
    const comment = h('textarea', { id: 'comment' });
    // A tile that cannot be written as a formula: sign-off rests on its tests and needs a stated reason.
    const reason = opts.valuesOnly ? h('textarea', { id: 'valuesonly' }) : null;
    const confirm = h('button', { type: 'button', id: 'confirm', disabled: true, onclick: () => close({ reviewer: reviewer.value.trim(), comment: comment.value.trim(), valuesOnly: reason ? reason.value.trim() : undefined }) }, 'Confirm');
    const update = () => { confirm.disabled = !(boxes.every(b => b.checked) && reviewer.value.trim() && (!reason || reason.value.trim())); };
    boxes.forEach(b => b.addEventListener('change', update));
    reviewer.addEventListener('input', update);
    if (reason) reason.addEventListener('input', update);
    update();

    const children = [h('div', { class: 'dtitle' }, opts.title)];
    if (blocked) {
      children.push(h('h3', { class: 'sec' }, 'Cannot be signed off'),
        h('ul', {}, opts.blockers.map(b => h('li', {}, b))));
    }
    children.push(...(opts.sections || []));
    if (!blocked) {
      if ((opts.assumptions || []).length) {
        children.push(h('h3', { class: 'sec' }, 'Assumptions to confirm'),
          ...opts.assumptions.map((a, i) => h('label', { class: 'ck' }, boxes[i], h('span', {}, a))));
      }
      if ((opts.warnings || []).length) {
        children.push(h('h3', { class: 'sec' }, 'Warnings'), ...opts.warnings.map(w => h('p', { class: 'warn' }, w)));
      }
      if (reason) children.push(h('h3', { class: 'sec' }, 'Values only'), h('p', { id: 'valuesonlytext' }, opts.valuesOnly),
        h('div', { class: 'field' }, h('label', {}, 'Reason (required)', h('br'), reason)));
      children.push(h('div', { class: 'field' }, h('label', {}, 'Comment', h('br'), comment)),
        h('div', { class: 'field' }, h('label', {}, 'Reviewer', h('br'), reviewer)));
    } else if ((opts.warnings || []).length) {
      children.push(h('h3', { class: 'sec' }, 'Warnings'), ...opts.warnings.map(w => h('p', { class: 'warn' }, w)));
    }
    children.push(h('div', { class: 'buttons' }, h('button', { type: 'button', id: 'cancel', onclick: () => close(null) }, blocked ? 'Close' : 'Cancel'), blocked ? null : confirm));
    overlay.append(h('div', { id: 'dialog', role: 'dialog', 'aria-modal': 'true' }, children));
    document.body.append(overlay);
    (blocked ? overlay.querySelector('#cancel') : (boxes[0] || comment)).focus();
  });
}

// Plain form modal. opts: {title, intro:[string|Node], fields:[{id,label,value,multiline,placeholder,optional,button:{id,text,onclick(input)}}],
// confirm, sections:[Node], submit(values, say) -> Promise<null | string[] | {result: string[]}>}.
// A returned list of lines is shown in the dialog, which stays open; `{result}` shows the lines as the outcome and the
// dialog then offers only Close. `say(line)` adds a line of progress while the submit runs.
export function formDialog(opts) {
  return new Promise(resolve => {
    const overlay = h('div', { id: 'overlay' });
    let working = false;
    const close = result => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(result); };
    const onKey = e => { if (e.key === 'Escape' && !working) close(null); };
    document.addEventListener('keydown', onKey);
    const inputs = {};
    const fields = (opts.fields || []).map(f => {
      const el = f.multiline ? h('textarea', { id: 'f-' + f.id, value: f.value || '', placeholder: f.placeholder }) : h('input', { type: 'text', id: 'f-' + f.id, value: f.value || '', autocomplete: 'off', placeholder: f.placeholder });
      inputs[f.id] = el;
      const btn = f.button ? h('button', { type: 'button', id: f.button.id, onclick: () => f.button.onclick(el) }, f.button.text) : null;
      return h('div', { class: 'field' }, h('label', {}, f.label, h('br'), btn ? h('span', { class: 'inlinerow' }, el, btn) : el));
    });
    const errors = h('div', { id: 'dialogerrors' });
    const progress = h('div', { id: 'dialogprogress', class: 'grey' });
    const say = line => { progress.append(h('p', {}, line)); };
    const status = h('span', { id: 'dialogworking', class: 'grey' });
    const cancel = h('button', { type: 'button', id: 'cancel', onclick: () => close(null) }, 'Cancel');
    const go = h('button', { type: 'button', id: 'confirm', onclick: async () => {
      const values = {};
      for (const f of opts.fields || []) values[f.id] = inputs[f.id].value.trim();
      working = true; go.disabled = true; cancel.disabled = true; status.textContent = 'Working… ';
      errors.replaceChildren(); progress.replaceChildren();
      let lines = null;
      try { lines = await opts.submit(values, say); } catch (e) { lines = [String(e && e.message || e)]; }
      working = false; status.textContent = '';
      if (lines && !Array.isArray(lines) && lines.result) {
        errors.replaceChildren(...lines.result.map(l => h('p', { class: 'okline' }, l)));
        cancel.disabled = false; cancel.textContent = 'Close'; go.remove();
        for (const i of Object.values(inputs)) i.disabled = true;
      } else if (lines && lines.length) {
        errors.replaceChildren(...lines.map(l => h('p', { class: 'warn' }, l)));
        go.disabled = false; cancel.disabled = false;
      } else close(values);
    } }, opts.confirm || 'OK');
    const check = () => { go.disabled = !(opts.fields || []).every(f => f.optional || inputs[f.id].value.trim()) || (opts.canSubmit ? !opts.canSubmit() : false); };
    Object.values(inputs).forEach(i => i.addEventListener('input', check));
    check();
    overlay.append(h('div', { id: 'dialog', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'dtitle' }, opts.title),
      ...(opts.intro || []).map(t => h('p', {}, t)),
      ...(opts.sections || []),
      ...fields, progress, errors,
      h('div', { class: 'buttons' }, status, cancel, go)));
    document.body.append(overlay);
    if (opts.onReady) opts.onReady(check);
    const first = Object.values(inputs).find(i => !i.disabled);
    if (first) first.focus();
  });
}
