import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';
import { checkVersion } from './check-manifest.mjs';

export function packageExtension(dist = 'dist', output = 'release') {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const manifest = JSON.parse(
    readFileSync(join(dist, 'manifest.json'), 'utf8'),
  );
  checkVersion(manifest, pkg);
  const entries = Object.create(null);
  function collect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile())
        entries[relative(dist, path).split(sep).join('/')] = [
          readFileSync(path),
          { mtime: new Date('2020-01-01T00:00:00Z') },
        ];
      else throw new Error(`Cannot package non-regular file: ${path}`);
    }
  }
  collect(dist);
  const archive = zipSync(entries, { level: 9 });
  const name = `extension-${pkg.version}.zip`;
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, name), archive);
  writeFileSync(
    join(output, 'SHA256SUMS'),
    `${createHash('sha256').update(archive).digest('hex')}  ${name}\n`,
  );
  console.log(`Packaged ${name} with SHA256SUMS in ${output}.`);
  return { name, archive };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  packageExtension();
