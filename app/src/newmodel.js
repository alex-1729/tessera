'use strict';
// New model: a local folder and a GitHub link. Each step is reported in words through `progress(line)`.
//   1. git ls-remote checks the link (the user's existing git sign-in; nothing is created if it fails)
//   2. a repository with commits is cloned; it must hold tilekit.toml at its root
//   3. an empty repository gets `tilekit init`, `git init -b main`, origin, and a first local commit (never pushed)
const fs = require('fs');
const path = require('path');
const git = require('./git');
const { isModelDir } = require('./models');

const slug = name => (String(name).toLowerCase().match(/[a-z0-9]+/g) || []).join('-') || 'model';
const entries = dir => { try { return fs.readdirSync(dir); } catch { return null; } };

// The folder the model goes in: the chosen folder when it is empty (or does not exist yet), else a new subfolder.
function targetFor(folder, name) {
  const e = entries(folder);
  if (e === null || e.length === 0) return folder;
  const sub = path.join(folder, slug(name));
  const s = entries(sub);
  if (s !== null && s.length) throw new Error(`The folder ${sub} already exists and is not empty. Choose another folder.`);
  return sub;
}

async function createNewModel({ name, folder, github }, { runnerFor, progress = () => {} }) {
  name = String(name || '').trim();
  if (!name || name.length > 120) throw new Error('Give the model a name.');
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || folder.length > 500 || folder.includes('\0')) throw new Error('Choose a local folder for the model.');
  const link = git.parseGithubLink(github);
  if (!link.ok) throw new Error(link.error);
  const target = targetFor(folder, name);

  progress('Checking the repository link with git…');
  const remote = await git.checkRemote(link.url);   // throws a plain sentence; nothing has been created yet
  progress(remote.commits ? 'The repository exists and has commits.' : 'The repository exists and is empty.');

  if (remote.commits) {
    const created = entries(target) === null;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    progress(`Cloning it into ${target}…`);
    try { await git.clone(link.url, target); }
    catch (e) {
      if (created) fs.rmSync(target, { recursive: true, force: true });
      throw new Error('Git could not clone the repository: ' + e.message);
    }
    if (!isModelDir(target)) throw new Error(`That repository is not a Tessera model (no tilekit.toml). The clone is in ${target}.`);
    progress('The repository holds a model.');
    return { dir: target, github: link.url, scaffold: false };
  }

  fs.mkdirSync(target, { recursive: true });
  progress('Creating the model with tilekit init…');
  await runnerFor(target)('init', ['--name', name]);
  progress('Starting a git repository on the main branch and adding the link as origin…');
  try { await git.initRepo(target, link.url, `Start ${name}`); }
  catch (e) { throw new Error(`The model was created in ${target}, but git could not start the repository: ${e.message}`); }
  progress('Made the first commit locally. Nothing is pushed.');
  return { dir: target, github: link.url, scaffold: true };
}

module.exports = { createNewModel, targetFor, slug };
