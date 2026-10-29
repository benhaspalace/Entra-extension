#!/usr/bin/env node
import { fetchThreads, repository } from './github.mjs';
import { parsePrArgs } from './lib.mjs';

const { pr } = parsePrArgs(process.argv.slice(2));
console.log(JSON.stringify(fetchThreads(pr, repository()), null, 2));
