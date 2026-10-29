import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './process.mjs';
import { loadConfig, resolveModel } from './config.mjs';

export function runAgent({
  role,
  task,
  prompt,
  readOnly = false,
  dryRun = false,
  model: override,
}) {
  if (typeof role !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(role))
    throw new Error('Agent role must be a safe file name.');
  const config = loadConfig();
  // The issue harness retains its explicit, per-run CLI model overrides.
  const model =
    override === undefined
      ? resolveModel(task, config)
      : resolveModel(task, { ...config, models: { [task]: override } });
  const directory = join('.agents', 'tmp');
  mkdirSync(directory, { recursive: true });
  const promptPath = join(directory, `${role}-prompt.md`);
  const replyPath = join(directory, `${role}-reply.md`);
  writeFileSync(promptPath, prompt);
  const instruction = `Read ${promptPath} and follow it exactly.`;
  const isWindows = process.platform === 'win32';
  const args = [
    '--model',
    model,
    '-p',
    isWindows ? `"${instruction}"` : instruction,
    '--allow-all-tools',
    ...(readOnly ? ['--deny-tool', 'write', '--deny-tool', 'shell'] : []),
    '-s',
  ];
  console.error(
    `[agent] ${role}${readOnly ? ' (read-only)' : ''}${dryRun ? ' (dry-run)' : ''}`,
  );
  const result = dryRun
    ? { ok: true, stdout: '', output: '' }
    : run(config.cli, args, { allowFail: true, shell: isWindows });
  writeFileSync(replyPath, result.output);
  return result;
}
