import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { loadLocalConfig } from './config.mjs';

export function redactEnvironmentPaths(
  text,
  { repo = process.cwd(), home = homedir(), tmp = tmpdir() } = {},
) {
  const paths = [
    [repo, '<repo>'],
    [home, '<home>'],
    [tmp, '<tmp>'],
  ].filter(([path]) => path);
  paths.sort(([left], [right]) => right.length - left.length);
  for (const [path, replacement] of paths) {
    const pattern = path
      .split(/[\\/]/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\\\/]');
    text = text.replace(new RegExp(pattern, 'gi'), () => replacement);
  }
  return text;
}

/** Literal, case-insensitive substring matches, deduplicated in configured order. */
export function findForbidden(text, terms) {
  const lower = redactEnvironmentPaths(text).toLowerCase();
  const seen = new Set();
  return terms.filter((term) => {
    const key = term.toLowerCase();
    if (!key || seen.has(key) || !lower.includes(key)) return false;
    seen.add(key);
    return true;
  });
}

export const loadForbiddenTerms = () => loadLocalConfig().forbiddenTerms ?? [];

export class ForbiddenTermError extends Error {
  constructor(label, matches) {
    super(`${label} contains forbidden term(s): ${matches.join(', ')}`);
    this.name = 'ForbiddenTermError';
  }
}

export function assertClean(label, text, terms = loadForbiddenTerms()) {
  const matches = findForbidden(text, terms);
  if (matches.length) throw new ForbiddenTermError(label, matches);
}

export const NEUTRAL_STOP =
  'Publishing stopped by the local text policy. Owner review is required.';

export function stopComment(error, branch) {
  const message = redactEnvironmentPaths(error.message);
  if (
    error instanceof ForbiddenTermError ||
    findForbidden(message, loadForbiddenTerms()).length
  )
    return NEUTRAL_STOP;
  const where = branch
    ? ` on branch \`${redactEnvironmentPaths(branch)}\``
    : '';
  return `Agent harness stopped${where}:\n\n\`\`\`\n${message.slice(-3000)}\n\`\`\``;
}

/** Scan both index blobs and working copies; neither can hide a match in the other. */
export function checkFiles(git, terms = loadForbiddenTerms()) {
  if (!terms.length) return;
  const entries = git(['ls-files', '--stage', '-z'])
    .stdout.split('\0')
    .filter(Boolean);
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    const [mode, , stage] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (mode === '160000') continue; // Submodules have no file blob.
    assertClean(
      `Staged file ${path}`,
      git(['show', `:${stage}:${path}`]).stdout,
      terms,
    );
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue; // Unstaged deletion.
      throw error;
    }
    assertClean(`Tracked file ${path}`, text, terms);
  }
}

function checkJsonStrings(value, terms) {
  if (typeof value === 'string') {
    assertClean('GitHub JSON input', value, terms);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) checkJsonStrings(child, terms);
  }
}

function checkInput(text, terms) {
  assertClean('GitHub input', text, terms);
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return;
  }
  checkJsonStrings(decoded, terms);
}

/** Last-mile protection shared by the issue harness and PR scripts. */
export function checkGithub(args, options = {}) {
  const terms = loadForbiddenTerms();
  if (!terms.length) return;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    assertClean('GitHub argument', arg, terms);
    if (arg === '--body-file' || arg === '--input') {
      const path = args[++index];
      const text = path === '-' ? options.input : readFileSync(path, 'utf8');
      if (text !== undefined) {
        assertClean('GitHub text file', text, terms);
        if (arg === '--input') checkInput(text, terms);
      }
    }
  }
  if (options.input !== undefined) checkInput(options.input, terms);
}

export function checkGit(args, git) {
  if (args[0] !== 'commit' && args[0] !== 'push') return;
  const terms = loadForbiddenTerms();
  if (!terms.length) return;
  for (let index = 1; index < args.length; index++) {
    assertClean('Git argument', args[index], terms);
    if (args[index] === '-F' || args[index] === '--file')
      assertClean('Commit message', readFileSync(args[++index], 'utf8'), terms);
  }
  checkFiles(git, terms);
}
