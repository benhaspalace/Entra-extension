#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { git } from '../harness/process.mjs';
import {
  AGENT_RULES,
  agent,
  assertSnapshot,
  gateWithRetries,
  requireClean,
  snapshot,
  verify,
} from './workflow.mjs';

export function sync(branch, base) {
  for (const ref of [branch, base]) {
    if (!ref || ref.startsWith('-'))
      throw new Error('Pass valid branch and base names.');
    git(['check-ref-format', '--branch', ref]);
  }
  if (branch === base) throw new Error('Branch and base must differ.');
  requireClean();
  git(['fetch', 'origin', '--', branch, base]);
  git(['switch', '--', branch]);
  requireClean();
  // Never publish from a stale or divergent local head.
  if (
    git(['rev-parse', 'HEAD']).stdout.trim() !==
    git(['rev-parse', `refs/remotes/origin/${branch}`]).stdout.trim()
  )
    throw new Error('Local branch must match its remote head before syncing.');
  const original = snapshot();
  try {
    const merge = git(
      ['merge', '--no-commit', '--no-ff', `refs/remotes/origin/${base}`],
      { allowFail: true },
    );
    if (!merge.ok) {
      const conflicts = git(['diff', '--name-only', '--diff-filter=U', '-z'])
        .stdout.split('\0')
        .filter(Boolean);
      if (!conflicts.length)
        throw new Error(
          `Merge failed without file conflicts:\n${merge.output}`,
        );
      agent({
        role: 'pr-sync-conflicts',
        task: 'implement',
        prompt: `${AGENT_RULES}\nResolve the current merge of origin/${base} into ${branch}, preserving both branches' intended behavior.
Conflicted files: ${JSON.stringify(conflicts)}
Resolve conflict markers and stage the resolved files. Do not commit or abort the merge.`,
      });
      assertSnapshot(original);
      git(['add', '--', ...conflicts]);
      if (git(['diff', '--name-only', '--diff-filter=U']).stdout.trim())
        throw new Error('Unresolved merge conflicts remain.');
    }
    const merging = git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
      allowFail: true,
    }).ok;
    if (merging) {
      gateWithRetries(
        'pr-sync',
        'implement',
        `Resolve the merge of origin/${base} into ${branch}.`,
      );
    } else {
      const result = verify();
      if (!result.ok) throw new Error(`Quality gate failed:\n${result.output}`);
    }
    assertSnapshot(original);
    git(['diff', '--check']);
    git(['add', '-A']);
    git(['diff', '--cached', '--check']);
    if (
      git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true }).ok
    )
      git(['commit', '-m', `Merge origin/${base} into ${branch}`]);
  } catch (error) {
    if (
      git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true }).ok
    ) {
      const abort = git(['merge', '--abort'], { allowFail: true });
      if (!abort.ok)
        throw new Error(
          `${error.message}\nMerge abort also failed:\n${abort.output}`,
          { cause: error },
        );
    }
    throw error;
  }
  git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  console.log(`Synced ${branch} with origin/${base}.`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error('Usage: pr:sync -- <branch> <base>');
  sync(...args);
}
