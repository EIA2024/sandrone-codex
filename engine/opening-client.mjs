import {createHash, randomUUID} from 'node:crypto';
import {prepareOpening as prepareRenderer, showOpening as showRenderer} from './renderer.mjs';

const chunkSize = 256 * 1024;
const pending = new WeakMap();
const revisions = new WeakMap();
const invoke = (fn, ...args) => `(${fn.toString()})(${args.map(value => JSON.stringify(value)).join(',')})`;
const mediaTimeout = {timeoutMs: 15000};

// openingAssets() returns an immutable payload for one engine session. Hashing
// its contents and player code prevents a stale renderer cache after a reload.
function revisionFor(assets) {
  if (!revisions.has(assets)) revisions.set(assets, createHash('sha256')
    .update(prepareRenderer.toString()).update(showRenderer.toString())
    .update(JSON.stringify(assets)).digest('hex'));
  return revisions.get(assets);
}

async function transfer(evaluate, assets, revision) {
  const state = await evaluate(`({epoch:window.__SANDRONE_OPENING_EPOCH__||0,reusable:Boolean(window.__SANDRONE_PLAYER__?.revision===${JSON.stringify(revision)}&&window.__SANDRONE_MEDIA_CACHE__?.revision===${JSON.stringify(revision)}&&!window.__SANDRONE_MEDIA_CACHE__.disposed&&window.__SANDRONE_MEDIA_CACHE__.reduced===matchMedia('(prefers-reduced-motion:reduce)').matches)})`);
  const withContext = result => result?.prepared ? {...result, epoch: state.epoch, revision} : result;
  if (state.reusable) return withContext(await evaluate("window.__SANDRONE_MEDIA_CACHE__?.ready??{prepared:false,reason:'cancelled'}", mediaTimeout));

  const token = randomUUID();
  // A restore or newer transfer deletes/replaces this token. Every later chunk
  // checks it, so a late preparation cannot bring back a disabled theme.
  const guard = `const input=window.__SANDRONE_OPENING_INPUT__;if(input?.token!==${JSON.stringify(token)})throw new Error('Opening preparation cancelled');`;
  try {
    await evaluate(`if((window.__SANDRONE_OPENING_EPOCH__||0)!==${state.epoch})throw new Error('Opening preparation cancelled');window.__SANDRONE_OPENING_INPUT__={token:${JSON.stringify(token)},assets:{}};`);
    for (const [name, asset] of Object.entries(assets)) {
      const value=JSON.stringify(asset);
      if(value===undefined)continue;
      const property = `input.assets[${JSON.stringify(name)}]`;
      if(value.length<=chunkSize){await evaluate(`(()=>{${guard}${property}=${value};})()`);continue;}
      await evaluate(`(()=>{${guard}${property}=[];})()`);
      for (let offset = 0; offset < value.length; offset += chunkSize) {
        await evaluate(`(()=>{${guard}${property}.push(${JSON.stringify(value.slice(offset, offset + chunkSize))});})()`);
      }
      await evaluate(`(()=>{${guard}${property}=JSON.parse(${property}.join(''));})()`);
    }
    return withContext(await evaluate(`(()=>{${guard}delete window.__SANDRONE_OPENING_INPUT__;window.__SANDRONE_PLAYER__={revision:${JSON.stringify(revision)},show:(${showRenderer.toString()})};return (${prepareRenderer.toString()})(input.assets,${JSON.stringify(revision)});})()`, mediaTimeout));
  } catch (error) {
    try { await evaluate(`if(window.__SANDRONE_OPENING_INPUT__?.token===${JSON.stringify(token)})delete window.__SANDRONE_OPENING_INPUT__;`); } catch {}
    if (String(error.message).includes('Opening preparation cancelled')) return {prepared: false, reason: 'cancelled'};
    throw error;
  }
}

/** Preload fixed validated assets; evaluate must await renderer promises. */
export function prepareOpening(evaluate, assets) {
  const revision = revisionFor(assets);
  const current = pending.get(evaluate);
  if (current?.revision === revision) return current.promise;
  const entry = {revision};
  entry.promise = transfer(evaluate, assets, revision).finally(() => {
    if (pending.get(evaluate) === entry) pending.delete(evaluate);
  });
  pending.set(evaluate, entry);
  return entry.promise;
}

/** Show/replay media, optionally consuming the caller's earlier preparation. */
export async function showOpening(evaluate, assets, options = {}, preparation) {
  const prepared = preparation ?? await prepareOpening(evaluate, assets);
  if (!prepared?.prepared) return {shown: false, reason: prepared?.reason || 'cancelled'};
  // Check cancellation in the same renderer turn that acquires the scene. A
  // restore after preloading must not start a new transfer or a later scene.
  return evaluate(`(()=>{if((window.__SANDRONE_OPENING_EPOCH__||0)!==${JSON.stringify(prepared.epoch)}||window.__SANDRONE_PLAYER__?.revision!==${JSON.stringify(prepared.revision)})return {shown:false,reason:'cancelled'};return window.__SANDRONE_PLAYER__.show(null,${JSON.stringify(options)});})()`, mediaTimeout);
}

/** Cancel pending preparation and fully release media when disabling a theme. */
export async function releaseOpening(evaluate) {
  pending.delete(evaluate);
  return evaluate(invoke(function release() {
    window.__SANDRONE_OPENING_EPOCH__=(window.__SANDRONE_OPENING_EPOCH__||0)+1;
    delete window.__SANDRONE_OPENING_INPUT__;
    window.__SANDRONE_OPENING__?.dispose?.('release');
    window.__SANDRONE_MEDIA_CACHE__?.dispose?.();
    delete window.__SANDRONE_PLAYER__;
    return {released: true};
  }));
}
