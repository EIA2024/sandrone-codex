import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mediaFiles, sha256 } from './startup-media.mjs';

const require = createRequire(import.meta.url);
function command(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error(`Cannot run ${file}: ${result.error?.message || result.stderr || 'exit ' + result.status}`);
  return result.stdout;
}
function browserModule() {
  if (process.env.PLAYWRIGHT_MODULE) return require(process.env.PLAYWRIGHT_MODULE);
  try { return require('playwright'); }
  catch {
    try { return require(path.join(path.dirname(process.execPath), 'node_modules/playwright')); }
    catch { throw new Error('Rendering requires Playwright. Install it for the build environment or set PLAYWRIGHT_MODULE to its absolute module path.'); }
  }
}
async function browserPath(chromium) {
  if (process.env.CHROMIUM_EXECUTABLE) return process.env.CHROMIUM_EXECUTABLE;
  const candidates = [chromium.executablePath()];
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
    candidates.push(path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe'));
  }
  for (const candidate of candidates) { try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch {} }
  throw new Error('Rendering requires Chromium, Chrome or Edge. Set CHROMIUM_EXECUTABLE to its executable.');
}

async function encode(ffmpeg, output, frames, recipe, capture, progress) {
  const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(recipe.fps), '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', recipe.encoder.preset, '-crf', String(recipe.encoder.crf), '-threads', String(recipe.encoder.threads), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-65536); });
  child.stdin.on('error', () => {});
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Startup encoder failed: ' + errors)));
  });
  void completed.catch(() => {});
  const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
  try {
    for (let index = 0; index < frames; index++) {
      if (child.exitCode !== null || child.stdin.destroyed) { await completed; throw new Error('Startup encoder closed its input early'); }
      const png = await capture(index);
      if (!child.stdin.write(png)) await Promise.race([once(child.stdin, 'drain'), completed.then(() => { throw new Error('Startup encoder closed before all frames were written'); })]);
      if (index % 60 === 0) progress(`${path.basename(output)}: ${index}/${frames}`);
    }
    child.stdin.end(); await completed;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) { child.kill(); await completed.catch(() => {}); }
  }
}

export async function renderStartupClips(root, output, progress = message => process.stderr.write(message + '\n')) {
  const recipe = JSON.parse(await fs.readFile(path.join(root, 'tools/startup-recipe.json'), 'utf8'));
  if (recipe.schema !== 1 || recipe.width !== 1920 || recipe.height !== 1080 || recipe.fps !== 30 || !['intro', 'idle'].every(key => Number.isSafeInteger(recipe[key]?.frames) && recipe[key].frames > 0 && recipe[key].frames <= 1800)) throw new Error('Unsupported startup rendering recipe');
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
  const encoderVersion = command(ffmpeg, ['-version']).split(/\r?\n/)[0];
  command(ffprobe, ['-version']);
  const { chromium } = browserModule();
  const browser = await chromium.launch({ headless: true, executablePath: await browserPath(chromium), args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const [{ openingAssets }, { prepareOpening, showOpening }] = await Promise.all(['engine/assets.mjs', 'engine/renderer.mjs'].map(name => import(pathToFileURL(path.join(root, name)).href)));
    const page = await browser.newPage({ viewport: { width: recipe.width, height: recipe.height }, deviceScaleFactor: 1 });
    await page.setContent('<html><body style="margin:0;background:#0b111b"></body></html>');
    await page.evaluate(() => { window.setInterval = () => 0; });
    const assets = await openingAssets();
    if (!assets.video || !assets.traceVideo || !assets.videoPoster || !assets.outline || !assets.signature) throw new Error('The source opening assets failed validation; refusing to bake a fallback into the release');
    await page.evaluate(`(${prepareOpening.toString()})(${JSON.stringify(assets)},'startup-authoring')`);
    await page.evaluate(`(${showOpening.toString()})(null,{replay:true})`);
    await page.evaluate(() => {
      const shadow = document.getElementById('sandrone-opening').shadowRoot;
      window.authoring = { shadow, scene: shadow.querySelector('.scene') };
      const style = document.createElement('style'); style.textContent = '.bottom{display:none!important}.scene,.motion,.trace-frame,.source-motion-frame{transition:none!important}'; shadow.append(style);
      for (const video of shadow.querySelectorAll('video')) { video.pause(); video.play = () => Promise.resolve(); }
      authoring.animations = authoring.scene.getAnimations({ subtree: true });
      for (const animation of authoring.animations) animation.pause();
    });
    async function frame(seconds) {
      await page.evaluate(async ({ seconds: time, recipe }) => {
        const { shadow, scene, animations } = authoring;
        const reveal = Math.max(0, Math.min(1, (time - recipe.colorStart) / recipe.colorDuration));
        scene.classList.add('motion-ready', 'source-trace-ready', 'prerender-ready');
        for (const animation of animations) { animation.pause(); animation.currentTime = time * 1000; }
        shadow.querySelector('.motion').style.opacity = String(reveal);
        shadow.querySelector('.motion-poster').style.opacity = '0';
        for (const selector of ['.trace-frame', '.source-motion-frame']) { const node = shadow.querySelector(selector); if (node) node.style.opacity = String(.9 * (1 - reveal)); }
        await Promise.all([...shadow.querySelectorAll('video')].map(video => new Promise((resolve, reject) => {
          const position = video.classList.contains('motion') ? time % recipe.sourceLoopSeconds : Math.min(time, recipe.traceEnd);
          if (Math.abs(video.currentTime - position) < .0001) return resolve();
          const timer = setTimeout(() => { video.removeEventListener('seeked', done); reject(new Error('Source video seek timed out')); }, 15000);
          function done() { clearTimeout(timer); resolve(); }
          video.addEventListener('seeked', done, { once: true }); video.currentTime = position;
        })));
      }, { seconds, recipe });
      return page.screenshot({ type: 'png', animations: 'allow' });
    }
    const manifest = { schema: 1, width: recipe.width, height: recipe.height, fps: recipe.fps, codec: 'H.264 yuv420p', audio: false, recipe, generator: { node: process.versions.node, browser: browser.version(), encoder: encoderVersion } };
    for (const kind of ['intro', 'idle']) {
      const { start, frames } = recipe[kind], file = mediaFiles[kind], target = path.join(output, file);
      await encode(ffmpeg, target, frames, recipe, index => frame(start + index / recipe.fps), progress);
      const probe = JSON.parse(command(ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', target]));
      const [stream] = probe.streams || [];
      if (probe.streams?.length !== 1 || stream.codec_name !== 'h264' || stream.width !== recipe.width || stream.height !== recipe.height || stream.pix_fmt !== 'yuv420p' || stream.avg_frame_rate !== recipe.fps + '/1' || Number(stream.nb_read_frames) !== frames || Math.abs(Number(stream.duration) - frames / recipe.fps) > .001) throw new Error('Encoded video does not match the startup recipe: ' + file);
      const bytes = await fs.readFile(target);
      manifest[kind] = { file, seconds: frames / recipe.fps, frames, sha256: sha256(bytes), bytes: bytes.length };
    }
    for (const [kind, seconds] of [['poster', recipe.intro.start], ['still', recipe.idle.start]]) {
      await frame(seconds);
      const bytes = await page.screenshot({ type: 'jpeg', quality: recipe.posterQuality });
      await fs.writeFile(path.join(output, mediaFiles[kind]), bytes);
      manifest[kind] = { file: mediaFiles[kind], sha256: sha256(bytes), bytes: bytes.length };
    }
    return manifest;
  } finally { await browser.close(); }
}
