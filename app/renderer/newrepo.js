// The "GitHub repository" part of the New model dialog: a choice between an existing repository (the link field) and a
// new one made on GitHub with the user's `gh` sign-in. This only collects the choice; the repository is created by the
// main process when the dialog's button is pressed, and from nowhere else.
import { h } from './util.js';

export const repoSlug = name => (String(name).toLowerCase().match(/[a-z0-9]+/g) || []).join('-');
const describe = name => (name.trim() ? `Tessera model: ${name.trim()}` : '');

// nameInput: the model name field. linkInput: the existing GitHub link field (its .field is moved under the first
// option). changed(): called whenever the answer to "can this be submitted" may have changed.
// Returns {mode(), values(), ready(), useExisting(link)}.
export function repoChoice({ api, nameInput, linkInput, confirmButton, changed }) {
  const radio = (id, name, checked) => h('input', { type: 'radio', id, name, checked });
  const existing = radio('r-existing', 'repomode', true);
  const create = radio('r-create', 'repomode', false);
  create.disabled = true;
  const createLabel = h('label', { class: 'ck off' }, create, h('span', {}, 'Create a new repository on GitHub'));
  const note = h('p', { id: 'r-note', class: 'grey reponote' }, 'Checking the GitHub command-line tool…');

  const owner = h('select', { id: 'r-owner' });
  const name = h('input', { type: 'text', id: 'r-name', autocomplete: 'off', spellcheck: 'false' });
  const nameError = h('p', { id: 'r-nameerror', class: 'warn', hidden: true });
  const priv = radio('r-private', 'repovis', true);
  const pub = radio('r-public', 'repovis', false);
  const desc = h('input', { type: 'text', id: 'r-desc', autocomplete: 'off', maxlength: '350' });
  const says = h('p', { id: 'r-says' });

  const linkField = linkInput.closest('.field');
  const existingBox = h('div', { class: 'repobox', id: 'r-existingbox' });
  const createBox = h('div', { class: 'repobox', id: 'r-createbox', hidden: true },
    h('div', { class: 'field' }, h('label', {}, 'Owner', h('br'), owner)),
    h('div', { class: 'field' }, h('label', {}, 'Repository name', h('br'), name), nameError),
    h('div', { class: 'field' }, h('div', {}, 'Visibility'),
      h('div', { class: 'visrow' }, h('label', { class: 'ck' }, priv, h('span', {}, 'Private')), h('label', { class: 'ck' }, pub, h('span', {}, 'Public')))),
    h('div', { class: 'field' }, h('label', {}, 'Description (optional)', h('br'), desc)),
    says);
  const group = h('div', { class: 'field repochoice' },
    h('div', { class: 'lab' }, 'GitHub repository'),
    h('label', { class: 'ck' }, existing, h('span', {}, 'Use an existing repository')), existingBox,
    createLabel, note, createBox);
  linkField.before(group);
  existingBox.append(linkField);

  let nameOk = false, nameTouched = false, descTouched = false, seq = 0;
  const mode = () => (create.checked && !create.disabled ? 'create' : 'existing');
  const visibility = () => (pub.checked ? 'public' : 'private');

  const paint = () => {
    const making = mode() === 'create';
    existingBox.hidden = making; createBox.hidden = !making;
    confirmButton.textContent = making ? 'Create repository and model' : 'Create';
    says.hidden = !(nameOk && owner.value);
    says.textContent = `Creates ${owner.value}/${name.value.trim()} on GitHub as a ${visibility()} repository. Nothing is pushed to it until you choose to push.`;
    changed();
  };
  const checkName = async () => {
    const mine = ++seq, text = name.value.trim();
    nameOk = false;
    let r = { ok: false, error: '' };
    try { r = await api.launch.checkRepoName(text); } catch (e) { r = { ok: false, error: e.message }; }
    if (mine !== seq) return;
    nameOk = r.ok;
    nameError.hidden = r.ok || !text; nameError.textContent = r.ok ? '' : r.error;
    paint();
  };

  nameInput.addEventListener('input', () => {
    if (!nameTouched) { name.value = repoSlug(nameInput.value); void checkName(); }
    if (!descTouched) desc.value = describe(nameInput.value);
  });
  name.addEventListener('input', () => { nameTouched = true; void checkName(); });
  desc.addEventListener('input', () => { descTouched = true; });
  for (const el of [existing, create, priv, pub, owner]) el.addEventListener('change', paint);

  api.launch.github().then(g => g, e => ({ ok: false, message: e.message })).then(g => {
    if (!g.ok) { note.textContent = g.message; return; }
    owner.replaceChildren(...g.owners.map(o => h('option', { value: o }, o)));
    create.disabled = false; createLabel.classList.remove('off'); note.hidden = true;
    paint();
  });
  paint();

  return {
    mode,
    ready: () => (mode() === 'create' ? nameOk && !!owner.value : !!linkInput.value.trim()),
    values: () => ({ owner: owner.value, name: name.value.trim(), visibility: visibility(), description: desc.value.trim() }),
    // after a repository was created but the model was not: the next try uses that repository, it does not make another
    useExisting: link => { existing.checked = true; linkInput.value = link; paint(); },
  };
}
