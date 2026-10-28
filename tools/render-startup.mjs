import path from 'node:path';
import { checkStartupMedia, checkStartupPackage, ensureStartupMedia } from './startup-media.mjs';

const args = process.argv.slice(2);
let root = path.resolve(import.meta.dirname, '..'), check = false, force = false, packageRoot, fingerprint;
try {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--root' && args[index + 1]) root = path.resolve(args[++index]);
    else if (args[index] === '--check-package' && args[index + 1]) packageRoot = path.resolve(args[++index]);
    else if (args[index] === '--fingerprint' && args[index + 1]) fingerprint = args[++index];
    else if (args[index] === '--check') check = true;
    else if (args[index] === '--force') force = true;
    else if (args[index] !== '--ensure') throw new Error('Usage: node tools/render-startup.mjs [--ensure | --check | --force] [--root <source directory>], or --check-package <theme directory> --fingerprint <sha256>');
  }
  if (check && force) throw new Error('--check and --force cannot be combined');
  const result = packageRoot
    ? { status: 'package-verified', fingerprint: (await checkStartupPackage(packageRoot, fingerprint)).source.fingerprint }
    : check
    ? { status: 'verified', fingerprint: (await checkStartupMedia(root)).source.fingerprint }
    : await ensureStartupMedia(root, { force, render: async directory => {
      process.stderr.write('Startup inputs or outputs changed; generating release media before packaging.\n');
      const { renderStartupClips } = await import('./startup-scene.mjs');
      return renderStartupClips(root, directory);
    } });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error('Startup media: ' + error.message);
  process.exitCode = 1;
}
