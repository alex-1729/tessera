'use strict';
// For the Electron suites that open a model with the real agent service. The right-hand pane then runs Claude Code,
// and a test must never start the real one: this puts test/fake-claude.js in its place (it calls no model, and runs
// the app's real bridge and hooks), and keeps Claude Code's saved conversations in the test's own temporary folder.
// Call it before requiring src/main.js. Returns {seen, records()}: what the stand-in saw, one object per line typed.
const fs = require('fs');
const path = require('path');

module.exports = function standIn(tmp) {
  const seen = path.join(tmp, 'fake-claude.jsonl');
  const program = path.join(tmp, 'claude');
  fs.writeFileSync(program, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${path.join(__dirname, 'fake-claude.js')}' "$@"\n`, { mode: 0o755 });
  process.env.APP_CLAUDE_BIN = program;
  process.env.FAKE_CLAUDE_OUT = seen;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude-config');
  const records = () => { try { return fs.readFileSync(seen, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  return { seen, records };
};
