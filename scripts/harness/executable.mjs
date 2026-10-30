import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';

function inside(root, path) {
  const suffix = relative(root, path);
  return !suffix || (!isAbsolute(suffix) && suffix.split(sep)[0] !== '..');
}

export function resolveAgentExecutable(cli, env = process.env) {
  const root = realpathSync(process.cwd());
  const windows = process.platform === 'win32';
  const extensions = windows ? ['', '.exe', '.com', '.cmd', '.bat'] : [''];
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    // npm prepends repository-owned executables; never trust those or cwd lookup.
    if (!isAbsolute(directory) || inside(root, resolve(directory))) continue;
    for (const extension of extensions) {
      try {
        const path = realpathSync(join(directory, `${cli}${extension}`));
        if (inside(root, path) || !statSync(path).isFile()) continue;
        if (windows && !/\.(exe|com|cmd|bat)$/i.test(path)) continue;
        if (windows && /["%!\r\n]/.test(path))
          throw new Error(
            'Agent executable path contains unsafe shell characters.',
          );
        accessSync(path, windows ? constants.F_OK : constants.X_OK);
        return path;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
      }
    }
  }
  throw new Error(
    `Cannot find trusted agent executable ${cli} on PATH outside the repository.`,
  );
}
