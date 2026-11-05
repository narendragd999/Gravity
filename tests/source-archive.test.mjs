import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('source archive excludes named Claude and other cookie exports while preserving examples', async t => {
  const candidates = process.env.PYTHON ? [process.env.PYTHON] : ['python', 'python3'];
  const python = candidates.find(candidate => spawnSync(candidate, ['--version'], { windowsHide: true }).status === 0);
  if (!python) return t.skip('Python 3 is needed to exercise the source archive tool.');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gravity-source-archive-'));
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  t.after(async () => {
    assert.equal(await fs.realpath(temporary), temporary);
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('gravity-source-archive-'));
    await fs.rm(temporary, { recursive: true });
  });
  const script = fileURLToPath(new URL('../scripts/source-archive.py', import.meta.url));
  const fixture = `
import importlib.util, json, pathlib, sys
spec = importlib.util.spec_from_file_location('archive_fixture', sys.argv[1])
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)
root = pathlib.Path(sys.argv[2])
for name in archive.FOLDERS:
    (root / name).mkdir()
for name in archive.FILES:
    (root / name).write_text('safe fixture', encoding='utf-8')
private = ['cookie_claude.txt', 'cookies-export.txt', 'Cookies.JSON', 'cookie_session.json', 'config.json', '.env.local', '.venv/credentials.json']
for name in private + ['config.example.json', 'cookie-handling.mjs']:
    file = root / 'bridges' / 'claude-web2api' / name
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text('disposable fixture', encoding='utf-8')
print(json.dumps(list(archive.source_inventory(root))))
`;
  const result = spawnSync(python, ['-c', fixture, script, temporary], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const inventory = JSON.parse(result.stdout);
  assert.ok(inventory.includes('Gravity/bridges/claude-web2api/config.example.json'));
  assert.ok(inventory.includes('Gravity/bridges/claude-web2api/cookie-handling.mjs'));
  assert.equal(inventory.filter(name => name.startsWith('Gravity/bridges/claude-web2api/')).length, 2);
});
