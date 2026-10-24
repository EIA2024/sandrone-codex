import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Geometry only: no SVG markup, URLs, style or executable content from assets.
export function validateOutline(value,sourceSha256){
 if(value?.version!==3||value.style!=='character-features-water'||value.width!==1280||value.height!==720||value.sourceSha256!==sourceSha256||!Array.isArray(value.paths)||value.paths.length<1||value.paths.length>96||!Array.isArray(value.facePaths)||value.facePaths.length<1||value.facePaths.length>32||!Array.isArray(value.waterPaths)||value.waterPaths.length!==1)throw new Error('Invalid outline geometry');
 validatePaths([...value.paths,...value.facePaths,...value.waterPaths],1280,720);
 return {width:1280,height:720,paths:value.paths,facePaths:value.facePaths,waterPaths:value.waterPaths};
}
function validatePaths(paths,width,height){
 for(const d of paths){
  if(typeof d!=='string'||d.length>12000||!/^M\d+(?:\.\d+)?,\d+(?:\.\d+)?(?: L\d+(?:\.\d+)?,\d+(?:\.\d+)?| Q\d+(?:\.\d+)?,\d+(?:\.\d+)? \d+(?:\.\d+)?,\d+(?:\.\d+)?)+$/.test(d))throw new Error('Invalid outline path');
  for(const pair of d.matchAll(/(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)/g)){if(Number(pair[1])>width||Number(pair[2])>height)throw new Error('Geometry outside canvas');}
 }
}
export function validateSignature(value,sourceSha256){
 if(value?.version!==1||value.width!==1080||value.height!==330||value.sourceSha256!==sourceSha256||value.origin!=='user-reference-vector-retrace'||!Array.isArray(value.paths)||value.paths.length<1||value.paths.length>12)throw new Error('Invalid signature geometry');
 validatePaths(value.paths,1080,330);return {width:1080,height:330,paths:value.paths};
}
export async function openingAssets(){
 const files={portrait:'assets/characters/sandrone/portrait.png',avatar:'assets/characters/sandrone/round-icon.png',background:'assets/backgrounds/dark-mechanical.jpg',gear:'assets/ornaments/01_ornate_gear.png',iris:'assets/ornaments/02_mechanical_iris.png',strings:'assets/ornaments/04_marionette_strings.png',cryo:'assets/ornaments/cryo.png',skill:'assets/ornaments/skill.png',burst:'assets/ornaments/burst.png'};
 const result={};for(const [key,name]of Object.entries(files)){
  try{const f=path.join(root,name);const stat=await fs.stat(f);if(!stat.isFile()||stat.size>10*1024*1024)throw new Error('Invalid asset size');const bytes=await fs.readFile(f);const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));const jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;if(!png&&!jpg)throw new Error('Invalid asset signature');result[key]=`data:image/${png?'png':'jpeg'};base64,${bytes.toString('base64')}`;}catch(error){if(['cryo','skill','burst'].includes(key)&&error.code==='ENOENT')continue;throw error;}
 }
 try{
  const reference=await fs.readFile(path.join(root,'assets/branding/signature-reference.jpg'));
  const geometry=await fs.readFile(path.join(root,'assets/branding/sandrone-signature.json'),'utf8');
  if(reference.length>2*1024*1024||geometry.length>64*1024)throw new Error('Signature too large');
  result.signature=validateSignature(JSON.parse(geometry),createHash('sha256').update(reference).digest('hex'));
 }catch{result.signatureFallback=true;}
 // Optional, fixed local MP4. A missing/broken video never blocks the static opening.
 try{
  const ledger=JSON.parse(await fs.readFile(path.join(root,'assets/motion/derived.json'),'utf8'));
  if(!['sandrone-loop-1080p.mp4','sandrone-loop-720p.mp4'].includes(ledger.file))throw new Error('Invalid fixed video filename');
  const file=path.join(root,'assets/motion',ledger.file);const stat=await fs.stat(file);
  if(!stat.isFile()||stat.size>12*1024*1024)throw new Error('Invalid optional video size');
  const bytes=await fs.readFile(file);if(bytes.subarray(4,8).toString()!=='ftyp')throw new Error('Invalid optional MP4');
  if(createHash('sha256').update(bytes).digest('hex')!==ledger.sha256)throw new Error('Optional video digest mismatch');
  result.video=`data:video/mp4;base64,${bytes.toString('base64')}`;
  try{
   if(ledger.trace?.content!=='source-environment-only'||ledger.trace?.file!=='sandrone-trace-1080p.mp4'||ledger.trace.sourceSha256!==ledger.sourceSha256)throw new Error('Invalid trace identity');
   const trace=await fs.readFile(path.join(root,'assets/motion/sandrone-trace-1080p.mp4'));
   if(trace.length>6*1024*1024||trace.subarray(4,8).toString()!=='ftyp'||createHash('sha256').update(trace).digest('hex')!==ledger.trace.sha256)throw new Error('Trace digest mismatch');
   result.traceVideo=`data:video/mp4;base64,${trace.toString('base64')}`;result.environmentTrace=true;
  }catch{result.traceFallback=true;}
  try{
   const poster=await fs.readFile(path.join(root,'assets/motion/sandrone-first-frame.jpg'));
   if(poster.length<1024*1024&&poster[0]===255&&poster[1]===216&&createHash('sha256').update(poster).digest('hex')===ledger.posterSha256){
    result.videoPoster=`data:image/jpeg;base64,${poster.toString('base64')}`;
    try{const outline=await fs.readFile(path.join(root,'assets/motion/sandrone-outline.json'),'utf8');if(outline.length<256*1024)result.outline=validateOutline(JSON.parse(outline),ledger.posterSha256);}catch{result.outlineFallback=true;}
   }
  }catch{}
 }catch{result.videoFallback=true;}
 // Video/poster is the static fallback; omit unused full-size WPF art from
 // the renderer transfer when the validated HD pair is available.
 if(result.traceVideo&&result.videoPoster&&result.outline){for(const key of ['portrait','background','gear','iris','strings'])delete result[key];result.background=result.videoPoster;}
 return result;
}
