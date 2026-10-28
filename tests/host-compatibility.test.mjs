import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPE, openAsar, hasUpdaterLoad, inspectHost } from '../native-integration/host-compatibility.mjs';
const policy = JSON.parse(fs.readFileSync(new URL('../native-integration/compatibility.json', import.meta.url), 'utf8'));

// Minimal PE/ASAR containers exercise format boundaries without redistributing
// official binaries. The two signed releases are checked by the build acceptance test.
function pe(names, imports = {}) {
  const b = Buffer.alloc(16384); b.writeUInt16LE(0x5a4d); b.writeUInt32LE(0x80, 0x3c);
  const optional = 0x98; b.writeUInt32LE(0x4550, 0x80); b.writeUInt16LE(0x8664, 0x84);
  b.writeUInt16LE(1, 0x86); b.writeUInt16LE(240, 0x94); b.writeUInt16LE(0x20b, optional);
  const section = optional + 240; b.writeUInt32LE(12288, section + 16); b.writeUInt32LE(0x1000, section + 12); b.writeUInt32LE(0x200, section + 20);
  const rva = offset => offset - 0x200 + 0x1000;
  let cursor = 0x800;
  const str = text => { const at = cursor; b.write(text, at, 'ascii'); cursor += text.length + 1; return at; };
  b.writeUInt32LE(rva(0x200), optional + 112); b.writeUInt32LE(names.length, 0x200 + 24); b.writeUInt32LE(rva(0x300), 0x200 + 32);
  names.forEach((name, i) => b.writeUInt32LE(rva(str(name)), 0x300 + i * 4));
  if (Object.keys(imports).length) b.writeUInt32LE(rva(0x400), optional + 120);
  Object.entries(imports).forEach(([library, symbols], index) => {
    const descriptor = 0x400 + index * 20, thunk = 0x500 + index * 128;
    b.writeUInt32LE(rva(thunk), descriptor); b.writeUInt32LE(rva(str(library)), descriptor + 12);
    symbols.forEach((symbol, i) => { const hint = cursor; cursor += 2; str(symbol); b.writeBigUInt64LE(BigInt(rva(hint)), thunk + i * 8); });
  });
  return b;
}
function asar(files) {
  const root = { files: {} }, chunks = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    let current = root; const parts = name.split('/');
    for (const part of parts.slice(0, -1)) current = current.files[part] ??= { files: {} };
    const bytes = Buffer.from(text); current.files[parts.at(-1)] = { size: bytes.length, offset: String(offset) };
    offset += bytes.length; chunks.push(bytes);
  }
  const json = Buffer.from(JSON.stringify(root)), headerSize = Math.ceil((json.length + 8) / 4) * 4;
  const header = Buffer.alloc(8 + headerSize); header.writeUInt32LE(4); header.writeUInt32LE(headerSize, 4); header.writeUInt32LE(headerSize - 4, 8); header.writeUInt32LE(json.length, 12); json.copy(header, 16);
  return Buffer.concat([header, ...chunks]);
}
const load = 'var q=(0,module.createRequire)(__filename);function updater(){return q((0,path.join)(process.resourcesPath,`native`,`windows-updater.node`))}';

test('loader recognition ignores chunk names but rejects a moved module or another require binding', () => {
  assert.equal(hasUpdaterLoad(load), true);
  assert.equal(hasUpdaterLoad(load.replace('windows-updater.node', 'changed.node')), false);
  assert.equal(hasUpdaterLoad(load.replace('return q(', 'return other(')), false);
  assert.equal(hasUpdaterLoad('const note="windows-updater.node"'), false);
});

test('native contract reads registration exports and imported symbols, rejecting malformed/x86 images', () => {
  const image = pe(policy.loader.exports, { 'chrome.dll': ['napi_get_undefined'] });
  assert.deepEqual([...readPE(image).exports], policy.loader.exports);
  assert.deepEqual(readPE(image).imports.get('chrome.dll'), ['napi_get_undefined']);
  assert.throws(() => readPE(image.subarray(0, 100)), /Truncated/);
  const x86 = Buffer.from(image); x86.writeUInt16LE(0x14c, 0x84);
  assert.throws(() => readPE(x86), /x64/);
});

test('new archive content stays compatible; changed native ABI and missing loading call fail closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandrone-contract-'));
  const write = (relative, bytes) => { const filename = path.join(root, relative); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, bytes); };
  const original = pe(policy.loader.exports, { 'chrome.dll': ['napi_get_undefined'] });
  const code = text => asar({ 'package.json': JSON.stringify({ main: '.vite/build/main-new.js' }), '.vite/build/main-new.js': 'require("./bootstrap-new.js")', '.vite/build/bootstrap-new.js': text, 'unrelated.txt': 'Updated every day' });
  try {
    write(policy.loader.module, original); write(policy.loader.runtime, pe([...policy.loader.bridgeSymbols, 'napi_get_undefined'])); write(policy.loader.asar, code(load));
    assert.equal(inspectHost(root, policy).compatible, true);
    write(policy.loader.asar, code(load + ';const unrelatedUIChange = 42;'));
    assert.equal(inspectHost(root, policy).compatible, true);
    write(policy.loader.module, pe(['napi_register_module_v2'], { 'chrome.dll': ['napi_get_undefined'] }));
    assert.throws(() => inspectHost(root, policy), /no longer exports/);
    write(policy.loader.module, pe(policy.loader.exports, { 'chrome.dll': ['v8_internal'] }));
    assert.throws(() => inspectHost(root, policy), /Node-API/);
    write(policy.loader.module, original); write(policy.loader.runtime, pe(['napi_get_undefined']));
    assert.throws(() => inspectHost(root, policy), /runtime is missing/);
    write(policy.loader.runtime, pe([...policy.loader.bridgeSymbols, 'napi_get_undefined'])); write(policy.loader.asar, code('const removed = true;'));
    assert.throws(() => inspectHost(root, policy), /load path/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ASAR entry ranges, links and invalid header sizes cannot be treated as code', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandrone-asar-')), filename = path.join(root, 'app.asar');
  try {
    const bytes = asar({ 'hello.js': 'hello' }); fs.writeFileSync(filename, bytes);
    const archive = openAsar(filename);
    try { assert.equal(archive.text('hello.js'), 'hello'); assert.throws(() => archive.text('missing'), /Unsupported/); } finally { archive.close(); }
    fs.writeFileSync(filename, bytes.subarray(0, bytes.length - 2));
    const short = openAsar(filename); try { assert.throws(() => short.text('hello.js'), /range/); } finally { short.close(); }
    bytes.writeUInt32LE(0xffffffff, 12); fs.writeFileSync(filename, bytes);
    assert.throws(() => openAsar(filename), /header/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
