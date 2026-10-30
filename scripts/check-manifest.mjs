import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { git } from './harness/process.mjs';

export function checkVersion(manifest, pkg) {
  if (
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version) ||
    manifest.version !== pkg.version
  )
    throw new Error('manifest.json and package.json versions must match.');
}

export function manifestGrants(manifest) {
  const grants = new Set();
  for (const field of ['permissions', 'host_permissions']) {
    for (const value of manifest[field] ?? []) grants.add(`${field}:${value}`);
  }
  for (const script of manifest.content_scripts ?? [])
    for (const match of script.matches ?? [])
      grants.add(`content_scripts.matches:${match}`);
  for (const [key, value] of Object.entries(
    manifest.content_security_policy ?? {},
  ))
    grants.add(`content_security_policy.${key}:${value}`);
  return grants;
}

export function checkPermissionDecisions(current, previous, decisions) {
  const old = manifestGrants(previous);
  const additions = [...manifestGrants(current)].filter(
    (grant) => !old.has(grant),
  );
  // Removing a CSP can weaken it too; require an explicit decision for that change.
  for (const key of Object.keys(previous.content_security_policy ?? {}))
    if (!(key in (current.content_security_policy ?? {})))
      additions.push(`content_security_policy.${key}:<removed>`);
  const approved = new Set(
    [...decisions.matchAll(/^- `([^`\r\n]+)`[ \t]+-[ \t]+\S.*$/gm)].map(
      (match) => match[1],
    ),
  );
  const missing = additions.filter((grant) => !approved.has(grant));
  if (missing.length)
    throw new Error(
      `Undocumented manifest additions:\n${missing.join('\n')}\nAdd exact entries with reasons to docs/permissions-decisions.md.`,
    );
  return additions;
}

export function checkManifest() {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  checkVersion(manifest, JSON.parse(readFileSync('package.json', 'utf8')));
  if (git(['rev-parse', '--is-shallow-repository']).stdout.trim() !== 'false')
    throw new Error(
      'Permission comparison needs full Git history and tags (fetch-depth: 0).',
    );
  // Exclude tags on HEAD so a new release cannot approve its own additions.
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  const tags = git([
    'tag',
    '--merged',
    'HEAD',
    '--list',
    'v*',
    '--sort=-version:refname',
  ])
    .stdout.trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const tag = tags.find(
    (value) => git(['rev-parse', `${value}^{commit}`]).stdout.trim() !== head,
  );
  const previous = tag
    ? JSON.parse(git(['show', `${tag}:manifest.json`]).stdout)
    : {};
  const additions = checkPermissionDecisions(
    manifest,
    previous,
    readFileSync('docs/permissions-decisions.md', 'utf8'),
  );
  console.log(
    `Manifest versions match; ${additions.length} documented additions against ${tag ?? 'empty bootstrap baseline'}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  checkManifest();
