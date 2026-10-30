#!/usr/bin/env node
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import { loadLocalConfig } from '../harness/config.mjs';
import { git, run } from '../harness/process.mjs';

export function parseImageArgs(argv) {
  if (!argv.length) return { ref: 'origin/main' };
  if (
    argv.length !== 2 ||
    argv[0] !== '--ref' ||
    !argv[1].trim() ||
    argv[1].startsWith('-') ||
    /[\0\r\n]/.test(argv[1])
  )
    throw new Error('Usage: npm run gate:image -- [--ref <trusted-git-ref>]');
  return { ref: argv[1] };
}

export function buildGateImage(argv = process.argv.slice(2)) {
  const { ref } = parseImageArgs(argv);
  const local = loadLocalConfig();
  const revision = git([
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`,
  ]).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision))
    throw new Error(`Cannot resolve trusted revision: ${ref}`);
  const lock = git(['show', `${revision}:package-lock.json`], {
    allowFail: true,
  });
  if (!lock.ok)
    throw new Error(
      `Trusted ref ${ref} has no readable package-lock.json. Use --ref <trusted-ref-with-lockfile>.\n${lock.output}`,
    );
  const manifest = git(['show', `${revision}:package.json`]).stdout;
  for (const [name, text] of [
    ['package.json', manifest],
    ['package-lock.json', lock.stdout],
  ]) {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`Invalid ${name} at trusted ref ${ref}.`);
  }

  const baseTag = 'node:22-bookworm-slim';
  run('docker', ['pull', baseTag]);
  const digests = JSON.parse(
    run('docker', ['inspect', '--format', '{{json .RepoDigests}}', baseTag])
      .stdout,
  );
  const baseImage = Array.isArray(digests)
    ? digests.find((digest) => /^node@sha256:[a-f0-9]{64}$/.test(digest))
    : undefined;
  if (!baseImage)
    throw new Error(
      'Docker did not return a digest-pinned Node 22 base image.',
    );

  const directory = mkdtempSync(join(tmpdir(), 'entra-gate-image-'));
  try {
    const context = join(directory, 'context');
    mkdirSync(context);
    writeFileSync(join(context, 'package.json'), manifest);
    writeFileSync(join(context, 'package-lock.json'), lock.stdout);
    copyFileSync(
      new URL('../../docker/gate.Dockerfile', import.meta.url),
      join(context, 'Dockerfile'),
    );
    const iid = join(directory, 'image-id');
    run('docker', [
      'build',
      '--pull=false',
      '--build-arg',
      `NODE_IMAGE=${baseImage}`,
      '--build-arg',
      `TRUSTED_REVISION=${revision}`,
      '--iidfile',
      iid,
      context,
    ]);
    const image = readFileSync(iid, 'utf8').trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(image))
      throw new Error('Docker did not return a valid gate image ID.');
    const configDirectory = join(process.cwd(), '.agents');
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(
      join(configDirectory, 'harness.local.json'),
      `${JSON.stringify(
        {
          ...local,
          prGateImage: image,
          prGateImageSource: { revision, baseImage },
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `Node base: ${baseImage}\nTrusted revision: ${revision}\nGate image: ${image}`,
    );
    return image;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  buildGateImage();
