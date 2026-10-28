// Package authenticity is checked before probing this loading contract.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function readPE(bytes) {
  const need = (offset, size) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.length) throw new Error('Truncated PE image');
    return offset;
  };
  const u16 = o => bytes.readUInt16LE(need(o, 2)), u32 = o => bytes.readUInt32LE(need(o, 4));
  if (u16(0) !== 0x5a4d) throw new Error('Missing PE DOS header');
  const pe = u32(0x3c);
  if (u32(pe) !== 0x4550 || u16(pe + 4) !== 0x8664 || u16(pe + 24) !== 0x20b) throw new Error('Expected an x64 PE32+ image');
  const count = u16(pe + 6), optionalSize = u16(pe + 20), optional = pe + 24;
  if (count > 96 || optionalSize < 128) throw new Error('Invalid PE section table');
  const sections = Array.from({ length: count }, (_, i) => {
    const start = optional + optionalSize + i * 40; need(start, 40);
    return { size: u32(start + 16), virtual: u32(start + 12), raw: u32(start + 20) };
  });
  const rva = value => {
    const section = sections.find(s => value >= s.virtual && value - s.virtual < s.size);
    if (!section) throw new Error('PE address is not backed by file data');
    return need(section.raw + value - section.virtual, 1);
  };
  const str = offset => {
    const end = bytes.indexOf(0, need(offset, 1));
    if (end < 0 || end - offset > 4096) throw new Error('Invalid PE string');
    return bytes.toString('ascii', offset, end);
  };
  const exports = new Set(), imports = new Map();
  const exportRva = u32(optional + 112), importRva = u32(optional + 120);
  if (exportRva) {
    const entry = rva(exportRva), namesCount = u32(entry + 24), names = rva(u32(entry + 32));
    if (namesCount > 100000) throw new Error('Invalid PE export count');
    for (let i = 0; i < namesCount; i++) exports.add(str(rva(u32(names + i * 4))));
  }
  if (importRva) {
    let descriptor = rva(importRva), terminated = false;
    for (let d = 0; d < 1024; d++, descriptor += 20) {
      need(descriptor, 20);
      const nameRva = u32(descriptor + 12);
      if (!nameRva) { terminated = true; break; }
      const library = str(rva(nameRva)).toLowerCase(), names = [];
      const thunk = rva(u32(descriptor) || u32(descriptor + 16));
      let thunkTerminated = false;
      for (let i = 0; i < 100000; i++) {
        const value = bytes.readBigUInt64LE(need(thunk + i * 8, 8));
        if (!value) { thunkTerminated = true; break; }
        names.push(value >> 63n ? '#' + (value & 0xffffn) : str(rva(Number(value)) + 2));
      }
      if (!thunkTerminated || imports.has(library)) throw new Error('Invalid PE imports');
      imports.set(library, names);
    }
    if (!terminated) throw new Error('Unterminated PE imports');
  }
  return { exports, imports };
}

export function openAsar(filename) {
  const fd = fs.openSync(filename, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const read = (offset, length) => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) throw new Error('Invalid ASAR entry range');
      const bytes = Buffer.alloc(length);
      if (fs.readSync(fd, bytes, 0, length, offset) !== length) throw new Error('Truncated ASAR');
      return bytes;
    };
    const header = read(0, 16), headerLength = header.readUInt32LE(12), dataOffset = 8 + header.readUInt32LE(4);
    if (headerLength > 32 * 1024 * 1024 || dataOffset < headerLength + 16) throw new Error('Invalid ASAR header');
    const entries = new Map();
    const walk = (node, prefix = '') => {
      for (const [name, entry] of Object.entries(node.files || {})) {
        if (!name || /[\\/:]/.test(name) || name === '.' || name === '..') throw new Error('Unsafe ASAR path');
        const key = prefix + name;
        if (entry.files) walk(entry, key + '/'); else entries.set(key, entry);
      }
    };
    walk(JSON.parse(read(16, headerLength).toString('utf8')));
    return {
      names: [...entries.keys()],
      text(name) {
        const entry = entries.get(name);
        if (!entry || entry.link || entry.unpacked || entry.size > 32 * 1024 * 1024) throw new Error('Unsupported ASAR code entry: ' + name);
        return read(dataOffset + Number(entry.offset), entry.size).toString('utf8');
      },
      close: () => fs.closeSync(fd),
    };
  } catch (error) { fs.closeSync(fd); throw error; }
}

export function hasUpdaterLoad(source) {
  // Match the known createRequire(__filename) + resources/native call, rather
  // than a versioned chunk name or the mere presence of the module filename.
  const bindings = [...source.matchAll(/([\w$]+)\s*=\s*(?:\([^;]{0,100}\bcreateRequire\)|[\w$.]*createRequire)\s*\(\s*__filename\s*\)/g)];
  return bindings.some(([, binding]) => {
    const escaped = binding.replaceAll('$', '\\$');
    return new RegExp('return\\s+' + escaped + '\\s*\\(\\s*(?:\\([^)]{0,80}\\bjoin\\)|[\\w$.]*join)\\s*\\(\\s*process\\.resourcesPath\\s*,\\s*[\x27\x22\x60]native[\x27\x22\x60]\\s*,\\s*[\x27\x22\x60]windows-updater\\.node[\x27\x22\x60]\\s*\\)\\s*\\)').test(source);
  });
}

export function inspectHost(root, policy) {
  if (policy.schema !== 2 || policy.loader.id !== 'windows-updater-napi-v1') throw new Error('Unknown loader policy');
  const file = relative => {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.includes(':') || relative.split('/').some(p => !p || p === '..' || p === '.')) throw new Error('Invalid host policy path');
    return path.join(root, relative);
  };
  const loader = policy.loader;
  const original = readPE(fs.readFileSync(file(loader.module)));
  const runtime = readPE(fs.readFileSync(file(loader.runtime)));
  for (const name of loader.exports) if (!original.exports.has(name)) throw new Error('Original updater no longer exports ' + name);
  const runtimeImports = original.imports.get('chrome.dll');
  if (!runtimeImports?.length || runtimeImports.some(name => !name.startsWith('napi_') && !name.startsWith('node_api_'))) throw new Error('Updater no longer uses only the supported Node-API ABI');
  for (const [library] of original.imports) {
    if (library !== 'chrome.dll' && !loader.systemLibraries.includes(library) && !/^api-ms-win-[a-z0-9-]+\.dll$/.test(library)) throw new Error('Unrecognized updater dependency: ' + library);
  }
  for (const name of [...runtimeImports, ...loader.bridgeSymbols]) if (!runtime.exports.has(name)) throw new Error('Electron runtime is missing ' + name);
  const archive = openAsar(file(loader.asar));
  try {
    const metadata = JSON.parse(archive.text('package.json'));
    const main = archive.text(metadata.main);
    const candidates = archive.names.filter(name => /^\.vite\/build\/bootstrap[-.][^/]*\.js$/.test(name) && main.includes(path.posix.basename(name)));
    const entry = candidates.find(name => hasUpdaterLoad(archive.text(name)));
    if (!entry && !hasUpdaterLoad(main)) throw new Error('Official main process no longer uses the supported updater load path');
    return { schema: 1, compatible: true, loader: loader.id, entry: entry || metadata.main, moduleExports: [...original.exports].sort(), runtimeSymbolsChecked: runtimeImports.length + loader.bridgeSymbols.length, scope: 'static loading contract; runtime capabilities are checked independently' };
  } finally { archive.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [root, policyPath, output] = process.argv.slice(2);
    const result = inspectHost(root, JSON.parse(fs.readFileSync(policyPath, 'utf8').replace(/^\uFEFF/, '')));
    if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } catch (error) { console.error('Host compatibility: ' + error.message); process.exitCode = 1; }
}
