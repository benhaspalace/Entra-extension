import { spawnSync } from 'node:child_process';
import { tail } from './lib.mjs';

export function run(
  command,
  args,
  { allowFail = false, shell = false, input } = {},
) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${
    result.error ? `\n${result.error.message}` : ''
  }`;
  const ok = result.status === 0 && !result.error;
  if (!ok && !allowFail)
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${tail(output, 3000)}`,
    );
  return { ok, stdout: result.stdout ?? '', output };
}

export const gh = (args, options) => run('gh', args, options);
export const git = (args, options) => run('git', args, options);
