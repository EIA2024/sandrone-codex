import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mediaFiles, sha256, readStartupInputs, validateStartupMedia, checkStartupMedia, checkStartupPackage, ensureStartupMedia } from '../tools/startup-media.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const sourceNames = ['engine/assets.mjs', 'engine/renderer.mjs', 'tools/render-startup.mjs', 'tools/startup-media.mjs', 'tools/startup-scene.mjs'];
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sandrone-generation-'));
  t.after(async () => { if (path.dirname(root) === path.resolve(os.tmpdir())) await fs.rm(root, { recursive: true, force: true }); });
  for (const name of sourceNames) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), 'source-v1'); }
  await fs.copyFile(path.join(repo, 'tools/startup-recipe.json'), path.join(root, 'tools/startup-recipe.json'));
  await fs.mkdir(path.join(root, 'assets/motion'), { recursive: true });
  await fs.writeFile(path.join(root, 'assets/portrait.png'), 'original-art');
  await fs.writeFile(path.join(root, 'assets/PROVENANCE.json'), JSON.stringify({ source: 'fixture art', files: [{ file: 'assets/portrait.png', sha256: sha256('original-art') }] }));
  const recipe = JSON.parse(await fs.readFile(path.join(root, 'tools/startup-recipe.json'), 'utf8'));
  // Tiny bytes exercise publication and cache invalidation only. Real video
  // dimensions, frame counts and decoding are checked by FFprobe/Chromium.
  async function render(directory, marker = 'one') {
    const manifest = { schema: 1, width: 1920, height: 1080, fps: recipe.fps, audio: false, recipe };
    for (const [kind, file] of Object.entries(mediaFiles)) {
      const bytes = Buffer.concat([file.endsWith('.mp4') ? Buffer.from('\0\0\0\x18ftyp') : Buffer.from([255, 216, 255]), Buffer.from(marker)]);
      await fs.writeFile(path.join(directory, file), bytes);
      manifest[kind] = { file, bytes: bytes.length, sha256: sha256(bytes), ...(recipe[kind] ? { frames: recipe[kind].frames, seconds: recipe[kind].frames / recipe.fps } : {}) };
    }
    return manifest;
  }
  return { root, render, recipe, out: path.join(root, 'assets/motion') };
}
async function outputs(root) {
  const names = ['assets/PROVENANCE.json', 'assets/motion/startup.json', ...Object.values(mediaFiles).map(name => 'assets/motion/' + name)];
  return Promise.all(names.map(async name => (await fs.readFile(path.join(root, name))).toString('hex')));
}

test('current outputs are reused without a renderer; new source bytes require regeneration', async t => {
  const f = await fixture(t);
  assert.equal((await ensureStartupMedia(f.root, { render: f.render })).status, 'rendered');
  const original = await outputs(f.root), first = (await checkStartupMedia(f.root)).source.fingerprint;
  assert.equal((await ensureStartupMedia(f.root, { render() { throw new Error('must not render'); } })).status, 'current');
  assert.deepEqual(await outputs(f.root), original);
  await fs.writeFile(path.join(f.root, 'engine/renderer.mjs'), 'source-v2');
  await assert.rejects(checkStartupMedia(f.root), /sources changed/);
  let count = 0;
  await ensureStartupMedia(f.root, { render: async directory => { count++; return f.render(directory, 'two'); } });
  assert.equal(count, 1);
  assert.notEqual((await checkStartupMedia(f.root)).source.fingerprint, first);
});

test('source art and generation code changes invalidate the media; provenance never hashes itself', async t => {
  const f = await fixture(t); await ensureStartupMedia(f.root, { render: f.render });
  const before = (await readStartupInputs(f.root)).fingerprint;
  await fs.writeFile(path.join(f.root, 'assets/new-art.png'), 'new source');
  assert.notEqual((await readStartupInputs(f.root)).fingerprint, before);
  await fs.rm(path.join(f.root, 'assets/new-art.png'));
  assert.equal((await readStartupInputs(f.root)).fingerprint, before);
  await fs.appendFile(path.join(f.root, 'tools/startup-scene.mjs'), '-changed');
  await assert.rejects(checkStartupMedia(f.root), /sources changed/);
  await ensureStartupMedia(f.root, { render: f.render });
  assert.equal((await ensureStartupMedia(f.root)).status, 'current');
});

test('same-size corruption and missing outputs regenerate; invalid provenance is repaired', async t => {
  const f = await fixture(t); await ensureStartupMedia(f.root, { render: f.render });
  const intro = path.join(f.out, mediaFiles.intro), bytes = await fs.readFile(intro);
  bytes[bytes.length - 1] ^= 1; await fs.writeFile(intro, bytes);
  await assert.rejects(checkStartupMedia(f.root), /digest mismatch/);
  await ensureStartupMedia(f.root, { render: f.render });
  await fs.rm(path.join(f.out, mediaFiles.idle));
  await assert.rejects(checkStartupMedia(f.root), { code: 'ENOENT' });
  await ensureStartupMedia(f.root, { render: f.render });
  const ledger = JSON.parse(await fs.readFile(path.join(f.root, 'assets/PROVENANCE.json'), 'utf8'));
  ledger.files.find(entry => entry.file.endsWith('/startup.json')).sha256 = '0'.repeat(64);
  await fs.writeFile(path.join(f.root, 'assets/PROVENANCE.json'), JSON.stringify(ledger));
  await assert.rejects(checkStartupMedia(f.root), /provenance mismatch/);
  await ensureStartupMedia(f.root, { render: f.render });
  assert.ok(await checkStartupMedia(f.root));
});

test('failed or incomplete generation does not replace any existing published artifact', async t => {
  const f = await fixture(t); await ensureStartupMedia(f.root, { render: f.render });
  const before = await outputs(f.root);
  await assert.rejects(ensureStartupMedia(f.root, { force: true, render: async directory => { await f.render(directory, 'new'); throw new Error('encoder failed'); } }), /encoder failed/);
  assert.deepEqual(await outputs(f.root), before);
  await assert.rejects(ensureStartupMedia(f.root, { force: true, render: async directory => { const manifest = await f.render(directory, 'new'); await fs.rm(path.join(directory, mediaFiles.still)); return manifest; } }), { code: 'ENOENT' });
  assert.deepEqual(await outputs(f.root), before);
  assert.ok(await checkStartupMedia(f.root));
});

test('inputs changing during a render prevent publication and locks reject overlapping builds', async t => {
  const f = await fixture(t); await ensureStartupMedia(f.root, { render: f.render });
  const before = await outputs(f.root);
  await assert.rejects(ensureStartupMedia(f.root, { force: true, render: async directory => {
    await assert.rejects(ensureStartupMedia(f.root, { render: f.render }), /Another startup generation/);
    const manifest = await f.render(directory, 'new');
    await fs.appendFile(path.join(f.root, 'assets/portrait.png'), '-edited');
    return manifest;
  } }), /inputs changed during rendering/);
  assert.deepEqual(await outputs(f.root), before);
  await ensureStartupMedia(f.root, { render: f.render });
  assert.ok(await checkStartupMedia(f.root));
});

test('a replacement failure restores the earlier media and manifest as a complete set', async t => {
  const f = await fixture(t); await ensureStartupMedia(f.root, { render: f.render });
  const before = await outputs(f.root), rename = fs.rename;
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === path.join(f.out, mediaFiles.idle)) throw new Error('output is locked');
    return rename(source, destination);
  });
  await assert.rejects(ensureStartupMedia(f.root, { force: true, render: directory => f.render(directory, 'replacement') }), /output is locked/);
  assert.deepEqual(await outputs(f.root), before);
  assert.ok(await checkStartupMedia(f.root));
});

test('manifests cannot redirect paths or claim a different timeline', async t => {
  const f = await fixture(t); await ensureStartupMedia(f.root, { render: f.render });
  const file = path.join(f.out, 'startup.json'), manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.intro.file = '../other.mp4'; await fs.writeFile(file, JSON.stringify(manifest));
  await assert.rejects(validateStartupMedia(f.out, await readStartupInputs(f.root)), /Invalid startup asset record/);
  manifest.intro.file = mediaFiles.intro; manifest.intro.frames = 3; manifest.intro.seconds = .1;
  await fs.writeFile(file, JSON.stringify(manifest));
  await assert.rejects(validateStartupMedia(f.out, await readStartupInputs(f.root)), /Invalid startup timeline/);
});

test('timeline edits regenerate metadata; package checks bind copied inputs to the same generation', async t => {
  const f = await fixture(t); await ensureStartupMedia(f.root, { render: f.render });
  f.recipe.intro.frames = 360; f.recipe.idle.start = 6;
  await fs.writeFile(path.join(f.root, 'tools/startup-recipe.json'), JSON.stringify(f.recipe));
  await assert.rejects(checkStartupMedia(f.root), /sources changed/);
  await ensureStartupMedia(f.root, { render: f.render });
  const manifest = await checkStartupMedia(f.root);
  assert.equal(manifest.intro.seconds, 6);
  const packaged = path.join(f.root, 'dist/package-theme');
  for (const name of ['engine', 'assets']) await fs.cp(path.join(f.root, name), path.join(packaged, name), { recursive: true });
  assert.ok(await checkStartupPackage(packaged, manifest.source.fingerprint));
  await assert.rejects(checkStartupPackage(packaged, '0'.repeat(64)), /source version differs/);
  await fs.writeFile(path.join(packaged, 'assets/portrait.png'), 'wrong source');
  await assert.rejects(checkStartupPackage(packaged, manifest.source.fingerprint), /differs from rendered source/);
});


test('media frame rate must match the source recipe', async t => {
  const f = await fixture(t);
  await ensureStartupMedia(f.root, { render: f.render });
  const manifestFile = path.join(f.out, 'startup.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  assert.equal(manifest.fps, 60);
  assert.equal(manifest.intro.seconds, 5.2);
  assert.equal(manifest.idle.seconds, 9);
  manifest.fps = 30;
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(validateStartupMedia(f.out, await readStartupInputs(f.root)), /Unsupported startup media format/);
});
