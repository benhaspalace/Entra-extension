#!/usr/bin/env node
import { fetchThreads, replyToThread, repository } from './github.mjs';
import { parsePrArgs } from './lib.mjs';

const args = process.argv.slice(2);
const noResolve = args.includes('--no-resolve');
const positional = args.filter((arg) => arg !== '--no-resolve');
if (positional.length !== 3 || !/^[1-9]\d*$/.test(positional[1]))
  throw new Error(
    'Usage: pr:reply -- <pr> <commentId> <message> [--no-resolve]',
  );
const { pr } = parsePrArgs([positional[0]]);
const commentId = Number(positional[1]);
const repo = repository();
const thread = fetchThreads(pr, repo, false).find(
  (item) => item.commentId === commentId,
);
if (!thread)
  throw new Error(
    `Review thread root comment ${commentId} not found on PR #${pr}.`,
  );
replyToThread(pr, repo, thread, positional[2], !noResolve);
