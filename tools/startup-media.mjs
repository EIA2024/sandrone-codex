import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const mediaFiles = Object.freeze({
  intro: 'sandrone-startup-intro.mp4', idle: 'sandrone-startup-idle.mp4',
  poster: 'sandrone-startup-poster.jpg', still: 'sandrone-startup-still.jpg',
});
const generated = new Set(['assets/PROVENANCE.json', 'assets/motion/startup.json', ...Object.values(mediaFiles).map(name => 'assets/motion/' + name)]);
const sources = ['engine/assets.mjs', 'engine/renderer.mjs', 'tools/render-startup.mjs', 'tools/startup-media.mjs', 'tools/startup-scene.mjs', 'tools/startup-recipe.json'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

export async function readStartupInputs(root) {
  const names = [...sources];
  // Include source art additions/removals as well as edits. The generated
  // outputs and their provenance ledger must not invalidate their own inputs.
  async function walk(relative) {
    if (!(await fs.lstat(path.join(root, relative))).isDirectory()) throw new Error('Invalid startup source directory: ' + relative);
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = relative + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Linked startup input: ' + name);
      if (generated.has(name)) continue;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) names.push(name);
    }
  }
  await walk('assets');
  const files = [];
  for (const name of names.sort()) {
    const file = path.join(root, name);
    if (!(await fs.lstat(file)).isFile()) throw new Error('Invalid startup input: ' + name);
    files.push({ file: name, sha256: sha256(await fs.readFile(file)) });
  }
  const recipe = JSON.parse(await fs.readFile(path.join(root, 'tools/startup-recipe.json'), 'utf8'));
  return { fingerprint: sha256(JSON.stringify(files)), files, recipe };
}

export async function validateStartupMedia(directory, inputs) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'startup.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.width !== 1920 || manifest.height !== 1080 || ![30, 60].includes(manifest.fps) || manifest.fps !== inputs?.recipe?.fps || manifest.audio !== false) throw new Error('Unsupported startup media format');
  if (!inputs || manifest.source?.fingerprint !== inputs.fingerprint || JSON.stringify(manifest.source.files) !== JSON.stringify(inputs.files)) throw new Error('Startup sources changed; regenerate the opening');
  if (JSON.stringify(manifest.recipe) !== JSON.stringify(inputs.recipe)) throw new Error('Startup timeline differs from the current recipe');
  for (const [kind, name] of Object.entries(mediaFiles)) {
    const asset = manifest[kind];
    if (asset?.file !== name || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid startup asset record: ' + kind);
    const file = path.join(directory, name);
    if (!(await fs.lstat(file)).isFile()) throw new Error('Invalid startup output: ' + name);
    const bytes = await fs.readFile(file);
    if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) throw new Error('Startup asset digest mismatch: ' + name);
    if (name.endsWith('.mp4') ? bytes.toString('ascii', 4, 8) !== 'ftyp' : bytes[0] !== 255 || bytes[1] !== 216) throw new Error('Invalid startup media header: ' + name);
    if (name.endsWith('.mp4') && (!Number.isSafeInteger(asset.frames) || asset.frames < 1 || asset.frames !== inputs.recipe[kind]?.frames || asset.seconds !== asset.frames / manifest.fps)) throw new Error('Invalid startup timeline: ' + name);
  }
  return manifest;
}

async function provenance(root, directory) {
  const ledger = JSON.parse(await fs.readFile(path.join(root, 'assets/PROVENANCE.json'), 'utf8'));
  if (!Array.isArray(ledger.files)) throw new Error('Invalid asset provenance ledger');
  const names = ['startup.json', ...Object.values(mediaFiles)];
  const updates = await Promise.all(names.map(async name => ({ file: 'assets/motion/' + name, sha256: sha256(await fs.readFile(path.join(directory, name))) })));
  ledger.files = [...ledger.files.filter(entry => !updates.some(update => update.file === entry.file)), ...updates];
  return json(ledger);
}

export async function checkStartupMedia(root) {
  const inputs = await readStartupInputs(root);
  const directory = path.join(root, 'assets/motion');
  const manifest = await validateStartupMedia(directory, inputs);
  const ledger = JSON.parse(await fs.readFile(path.join(root, 'assets/PROVENANCE.json'), 'utf8'));
  for (const name of ['startup.json', ...Object.values(mediaFiles)]) {
    const records = ledger.files.filter(entry => entry.file === 'assets/motion/' + name);
    if (records.length !== 1 || records[0].sha256 !== sha256(await fs.readFile(path.join(directory, name)))) throw new Error('Startup provenance mismatch: ' + name);
  }
  return manifest;
}

export async function checkStartupPackage(root, fingerprint) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint || '')) throw new Error('Expected startup source fingerprint is required');
  const directory = path.join(root, 'assets/motion');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'startup.json'), 'utf8'));
  if (manifest.source?.fingerprint !== fingerprint || sha256(JSON.stringify(manifest.source.files)) !== fingerprint) throw new Error('Packaged startup source version differs from the build');
  await validateStartupMedia(directory, manifest.source);
  for (const input of manifest.source.files) {
    // Build-only generator scripts stay in the source checkout. Validate all
    // renderer/source-art bytes that actually ship with this package.
    if (sources.includes(input.file) && input.file.startsWith('tools/')) continue;
    if (!/^(engine|assets)\//.test(input.file) || input.file.includes('\\') || input.file.split('/').some(part => !part || part === '.' || part === '..') || input.file.includes(':')) throw new Error('Invalid packaged startup source path');
    const file = path.join(root, input.file);
    if (!(await fs.lstat(file)).isFile() || sha256(await fs.readFile(file)) !== input.sha256) throw new Error('Packaged startup input differs from rendered source: ' + input.file);
  }
  return manifest;
}

// Validate a complete generation before publishing any file. Keep backups
// until all replacements succeed; the manifest is replaced after the media.
async function publish(root, stage) {
  const targets = [...Object.values(mediaFiles), 'startup.json'].map(name => ({ source: path.join(stage, name), target: path.join(root, 'assets/motion', name) }));
  targets.push({ source: path.join(stage, 'PROVENANCE.json'), target: path.join(root, 'assets/PROVENANCE.json') });
  const backups = path.join(stage, 'previous'); await fs.mkdir(backups);
  for (const [index, item] of targets.entries()) {
    item.backup = path.join(backups, String(index));
    try { await fs.copyFile(item.target, item.backup); item.existed = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const changed = [];
  try {
    for (const item of targets) { await fs.rename(item.source, item.target); changed.push(item); }
  } catch (error) {
    for (const item of changed.reverse()) {
      try { if (item.existed) await fs.copyFile(item.backup, item.target); else await fs.rm(item.target); }
      catch (restoreError) { throw new Error(`Startup output rollback failed; backups retained at ${backups}`, { cause: restoreError }); }
    }
    throw error;
  }
}

export async function ensureStartupMedia(root, { force = false, render } = {}) {
  root = path.resolve(root);
  const work = path.join(root, 'dist'); await fs.mkdir(work, { recursive: true });
  const lockPath = path.join(work, 'startup-render.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another startup generation owns dist/startup-render.lock; wait for it to finish, or remove a stale lock after confirming that process exited'); throw error; }
  let stage, complete = false;
  try {
    await lock.writeFile(json({ pid: process.pid, startedAt: new Date().toISOString() }));
    const inputs = await readStartupInputs(root);
    if (!force) {
      try { return { status: 'current', fingerprint: (await checkStartupMedia(root)).source.fingerprint }; }
      catch (error) { if (!['ENOENT', undefined].includes(error.code)) throw error; }
    }
    if (typeof render !== 'function') throw new Error('A renderer is required for stale or missing startup media');
    stage = await fs.mkdtemp(path.join(work, 'startup-render-'));
    const manifest = await render(stage);
    manifest.source = inputs;
    await fs.writeFile(path.join(stage, 'startup.json'), json(manifest));
    await validateStartupMedia(stage, inputs);
    if ((await readStartupInputs(root)).fingerprint !== inputs.fingerprint) throw new Error('Startup inputs changed during rendering; no outputs were replaced');
    await fs.writeFile(path.join(stage, 'PROVENANCE.json'), await provenance(root, stage));
    await publish(root, stage);
    await checkStartupMedia(root);
    complete = true;
    return { status: 'rendered', fingerprint: inputs.fingerprint };
  } finally {
    // Successful staging data is disposable. Failed output/backup evidence is
    // retained under ignored dist/, never mistaken for a publishable video.
    if (complete && stage && path.dirname(stage) === work) await fs.rm(stage, { recursive: true, force: true });
    await lock.close(); await fs.rm(lockPath, { force: true });
  }
}
