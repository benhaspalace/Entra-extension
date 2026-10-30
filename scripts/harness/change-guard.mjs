import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { git } from './process.mjs';

const isTestFile = (path) =>
  /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
  /(?:^|\/)__tests__\/.*\.[cm]?[jt]sx?$/.test(path);

// Compare declarations rather than diff lines: formatting and moving a case
// within its file must not look like deletion, nor may a new case hide one.
export function testCases(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length)
    throw new SyntaxError(
      `Cannot inspect test declarations in ${path}: invalid syntax.`,
    );
  const names = new Set(['it', 'test']);
  const cases = [];
  const printer = ts.createPrinter({ removeComments: true });
  const root = (node) => {
    if (ts.isIdentifier(node)) return node.text;
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    )
      return root(node.expression);
    if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node))
      return root(ts.isCallExpression(node) ? node.expression : node.tag);
    return null;
  };
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !['vitest', '@jest/globals', 'node:test'].includes(
        statement.moduleSpecifier.text,
      )
    )
      continue;
    const clause = statement.importClause;
    if (statement.moduleSpecifier.text === 'node:test' && clause?.name)
      names.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
      for (const element of clause.namedBindings.elements)
        if (
          ['it', 'test'].includes((element.propertyName ?? element.name).text)
        )
          names.add(element.name.text);
  }
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      names.has(root(node.expression)) &&
      node.arguments.length &&
      !(
        ts.isPropertyAccessExpression(node.expression) &&
        ['each', 'for', 'skipIf', 'runIf', 'extend'].includes(
          node.expression.name.text,
        )
      )
    ) {
      const title = node.arguments[0];
      cases.push(
        ts.isStringLiteralLike(title)
          ? title.text
          : printer.printNode(ts.EmitHint.Expression, title, source),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return cases;
}

export function changeViolations(changes, issue) {
  // Only the approved issue's title/body define scope, not agent-authored text
  // or incidental references in later comments.
  const scope = `${issue.title}\n${issue.body}`.replaceAll('\\', '/');
  const violations = [];
  for (const { path, before, after } of changes) {
    if (
      (path.startsWith('scripts/harness/') &&
        !scope.includes('scripts/harness/')) ||
      (path === 'docs/HARNESS.md' && !scope.includes('docs/HARNESS.md'))
    )
      violations.push(
        `${path}: out-of-scope edit; the approved issue title/body must explicitly mention ${
          path === 'docs/HARNESS.md' ? 'docs/HARNESS.md' : 'scripts/harness/'
        }.`,
      );
    if (!isTestFile(path)) continue;
    if (after === null) {
      if (before !== null)
        violations.push(
          `${path}: deleting an existing test file is not allowed.`,
        );
      continue;
    }
    let remaining;
    try {
      remaining = testCases(path, after);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      violations.push(
        `${path}: cannot inspect test declarations: invalid syntax.`,
      );
      continue;
    }
    if (before === null) continue;
    for (const title of testCases(path, before)) {
      const index = remaining.indexOf(title);
      if (index >= 0) remaining.splice(index, 1);
      else
        violations.push(
          `${path}: removed test case ${JSON.stringify(title)}; restore the existing case.`,
        );
    }
  }
  return violations;
}

export function checkChanges(base, issue) {
  const baseline = new Set(
    git(['ls-tree', '-r', '--name-only', '-z', base, '--'])
      .stdout.split('\0')
      .filter(Boolean),
  );
  const tracked = git(['diff', '--name-only', '-z', '--no-renames', base, '--'])
    .stdout.split('\0')
    .filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'])
    .stdout.split('\0')
    .filter(Boolean);
  const changes = [...new Set([...tracked, ...untracked])]
    .filter(
      (path) =>
        isTestFile(path) ||
        path.startsWith('scripts/harness/') ||
        path === 'docs/HARNESS.md',
    )
    .map((path) => ({
      path,
      before:
        isTestFile(path) && baseline.has(path)
          ? git(['show', `${base}:${path}`]).stdout
          : null,
      after: existsSync(join(process.cwd(), path))
        ? readFileSync(join(process.cwd(), path), 'utf8')
        : null,
    }));
  const violations = changeViolations(changes, issue);
  return { ok: !violations.length, output: violations.join('\n') };
}
