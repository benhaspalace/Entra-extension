import { pathToFileURL } from 'node:url';
import { gh } from '../harness/process.mjs';
import { repository, permissionLookup, fetchThreads } from './github.mjs';
import { parsePrArgs } from './lib.mjs';
import { reviewSettings } from './review-config.mjs';
import { checkReviewState } from './review-state.mjs';

export function fetchPages(endpoint) {
  const pages = JSON.parse(
    gh(['api', '--paginate', '--slurp', endpoint]).stdout,
  );
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
    throw new Error('GitHub did not return complete review-check pages.');
  return pages.flat();
}

export function reviewCheck(pr) {
  const config = reviewSettings();
  const repo = repository();
  const endpoint = `repos/${repo.owner.login}/${repo.name}`;
  const permission = permissionLookup(repo);
  const head = JSON.parse(
    gh([
      'pr',
      'view',
      String(pr),
      '--json',
      'headRefOid,mergeable,state,isDraft',
    ]).stdout,
  );
  const result = checkReviewState({
    ...head,
    headSha: head.headRefOid,
    comments: fetchPages(`${endpoint}/issues/${pr}/comments?per_page=100`),
    files: fetchPages(`${endpoint}/pulls/${pr}/files?per_page=100`),
    threads: fetchThreads(pr, repo, false),
    config,
    trustedRequest: (comment) =>
      comment.user?.type === 'User' &&
      !!comment.user.login &&
      (comment.user.login.toLowerCase() === repo.owner.login.toLowerCase() ||
        ['write', 'maintain', 'admin'].includes(
          permission(comment.user.login),
        )),
  });
  // Detect a concurrent push rather than publishing readiness for a different head.
  const current = JSON.parse(
    gh(['pr', 'view', String(pr), '--json', 'headRefOid']).stdout,
  );
  if (current.headRefOid !== head.headRefOid)
    return { exitCode: 1, reasons: ['PR head changed while checking; rerun.'] };
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = reviewCheck(parsePrArgs(process.argv.slice(2)).pr);
    console.log(
      result.exitCode === 0 ? 'Ready to merge.' : result.reasons.join('\n'),
    );
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`Review check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
