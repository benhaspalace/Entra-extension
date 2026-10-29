import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { generateIcons } from './icons.mjs';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  entryPoints: {
    background: 'src/background/index.ts',
    content: 'src/content/index.ts',
    'sidepanel/panel': 'src/sidepanel/panel.ts',
    'options/options': 'src/options/options.ts',
  },
  bundle: true,
  outdir: dist,
  target: 'chrome116',
  format: 'iife',
  sourcemap: true,
  logLevel: 'info',
});
await cp('manifest.json', new URL('../dist/manifest.json', import.meta.url));
for (const page of ['sidepanel', 'options']) {
  for (const asset of ['index.html', 'styles.css']) {
    await cp(
      new URL(`../src/${page}/${asset}`, import.meta.url),
      new URL(`../dist/${page}/${asset}`, import.meta.url),
    );
  }
}
await generateIcons(fileURLToPath(new URL('../dist/icons/', import.meta.url)));
