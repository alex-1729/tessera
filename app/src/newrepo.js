'use strict';
// New model with a NEW GitHub repository (the second option in the New model dialog). Reached only from `launch:new`,
// which only the dialog's button calls. Each step is reported in words through `progress(line)`.
//   1. `gh` must be signed in and the owner must be the account or one of its organisations
//   2. the name must be free (`gh repo view` says not found); if it is taken nothing happens
//   3. `gh repo create` makes an empty repository
//   4. then exactly as an empty existing repository: `tilekit init`, `git init -b main`, origin, a first local commit
// Nothing is pushed. If a step after 3 fails the repository is left as it is (never deleted) and the local folder is
// put back as it was.
const fs = require('fs');
const path = require('path');
const git = require('./git');
const gh = require('./github');
const { targetFor } = require('./newmodel');

const entries = dir => { try { return fs.readdirSync(dir); } catch { return null; } };
const noStop = text => String(text || '').trim().replace(/\.+$/, '');

async function createModelInNewRepo({ name, folder, repo }, { runnerFor, progress = () => {} }) {
  name = String(name || '').trim();
  if (!name || name.length > 120) throw new Error('Give the model a name.');
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || folder.length > 500 || folder.includes('\0')) throw new Error('Choose a local folder for the model.');
  const spec = gh.checkSpec(repo);
  const target = targetFor(folder, name);

  progress('Checking the GitHub command-line tool…');
  const who = await gh.account();
  if (!who.ok) throw new Error(who.message);
  if (!who.owners.includes(spec.owner)) throw new Error(`You are signed in to GitHub as ${who.login}, and ${spec.owner} is not that account or one of its organisations. Nothing was created.`);

  progress(`Checking that ${spec.full} is free on GitHub…`);
  if (await gh.repoExists(spec.owner, spec.name)) {
    throw new Error(`The repository ${spec.full} already exists on GitHub. Nothing was created. Choose another name, or choose "Use an existing repository" and give its link.`);
  }

  // the local folder first, so a folder that cannot be made stops things before anything exists on GitHub
  const existed = entries(target) !== null;       // targetFor: it is empty if it exists
  try { fs.mkdirSync(target, { recursive: true }); }
  catch (e) { throw new Error(`The folder ${target} could not be created (${e.code || e.message}). Nothing was created on GitHub.`); }
  const putBack = () => {
    try {
      if (!existed) fs.rmSync(target, { recursive: true, force: true });
      else for (const f of entries(target) || []) fs.rmSync(path.join(target, f), { recursive: true, force: true });
    } catch { /* reported by what failed */ }
  };
  const after = (what, link) => Object.assign(
    new Error(`The repository ${spec.full} was created on GitHub and is empty, but the model was not set up: ${noStop(what)}. No local folder was left behind. To try again, choose "Use an existing repository" and give its link: ${link}`),
    { detail: { created: spec.full, link } });

  progress(`Creating the ${spec.visibility} repository ${spec.full} on GitHub…`);
  let url;
  try { url = (await gh.createRepo(spec)).url; }
  catch (e) {
    putBack();
    if (e.created) throw after(e.message, `https://github.com/${spec.full}`);
    throw new Error(`GitHub did not create the repository ${spec.full}: ${noStop(e.message)}. Nothing was created.`);
  }
  progress(`Created ${spec.full}. It is empty.`);

  try {
    progress('Creating the model with tilekit init…');
    try { await runnerFor(target)('init', ['--name', name]); }
    catch (e) { throw new Error('tilekit init failed: ' + e.message); }
    progress('Starting a git repository on the main branch and adding the new repository as origin…');
    try { await git.initRepo(target, url, `Start ${name}`); }
    catch (e) { throw new Error('git could not start the local repository: ' + e.message); }
  } catch (e) { putBack(); throw after(e.message, url); }
  progress('Made the first commit locally. Nothing is pushed.');
  return { dir: target, github: url, scaffold: true, repo: spec.full };
}

module.exports = { createModelInNewRepo };
