import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './process.mjs';

export function resolveModel(task, config) {
  if (!Object.hasOwn(config.models ?? {}, task))
    throw new Error(`No Copilot model configured for task: ${task}`);
  const model = config.models[task];
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(model))
    throw new Error(`Invalid Copilot model for task: ${task}`);
  return model;
}

export function runCopilot({
  role,
  task,
  prompt,
  readOnly = false,
  dryRun = false,
  model: override,
}) {
  if (typeof role !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(role))
    throw new Error('Copilot role must be a safe file name.');
  const config = JSON.parse(
    readFileSync(join('.agents', 'harness.config.json'), 'utf8'),
  );
  // The issue harness retains its explicit, per-run CLI model overrides.
  const configured = resolveModel(task, config);
  const model =
    override === undefined
      ? configured
      : resolveModel(task, { models: { [task]: override } });
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
    `[copilot] ${role}: ${model}${readOnly ? ' (read-only)' : ''}${dryRun ? ' (dry-run)' : ''}`,
  );
  const result = dryRun
    ? { ok: true, stdout: '', output: '' }
    : run('copilot', args, { allowFail: true, shell: isWindows });
  writeFileSync(replyPath, result.output);
  return result;
}
