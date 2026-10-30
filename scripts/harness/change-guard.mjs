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
  return testDeclarations(path, text).cases;
}

function testDeclarations(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length)
    throw new SyntaxError(
      `Cannot inspect test declarations in ${path}: invalid syntax.`,
    );
  const names = new Set(['it', 'test']);
  const suites = new Set(['describe', 'suite']);
  const cases = [];
  let hasOnly = false;
  const printer = ts.createPrinter({ removeComments: true });
  const print = (node) =>
    printer.printNode(ts.EmitHint.Expression, node, source);
  const property = (node) =>
    ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isElementAccessExpression(node) &&
          node.argumentExpression &&
          ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : null;
  const modifiers = (node) => {
    if (ts.isIdentifier(node)) return [];
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    )
      return [...modifiers(node.expression), { name: property(node) }];
    if (ts.isCallExpression(node)) {
      const chain = modifiers(node.expression);
      if (['skipIf', 'runIf'].includes(property(node.expression)))
        chain[chain.length - 1].condition = node.arguments[0]
          ? print(node.arguments[0])
          : 'undefined';
      return chain;
    }
    if (ts.isTaggedTemplateExpression(node)) return modifiers(node.tag);
    return [];
  };
  const optionModifiers = (args) => {
    const result = [];
    for (const argument of args.slice(1)) {
      if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
        break;
      if (!ts.isObjectLiteralExpression(argument)) continue;
      for (const entry of argument.properties) {
        if (
          !ts.isPropertyAssignment(entry) &&
          !ts.isShorthandPropertyAssignment(entry)
        )
          continue;
        const key = ts.isComputedPropertyName(entry.name)
          ? entry.name.expression
          : entry.name;
        const name =
          ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : null;
        if (!['skip', 'todo', 'only'].includes(name)) continue;
        const value = ts.isPropertyAssignment(entry)
          ? entry.initializer
          : entry.name;
        if (value.kind === ts.SyntaxKind.FalseKeyword) continue;
        result.push(
          value.kind === ts.SyntaxKind.TrueKeyword
            ? { name }
            : { name, condition: print(value) },
        );
      }
    }
    return result;
  };
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
        else if (
          ['describe', 'suite'].includes(
            (element.propertyName ?? element.name).text,
          )
        )
          suites.add(element.name.text);
  }
  const visit = (node, enclosing = []) => {
    if (
      ts.isCallExpression(node) &&
      (names.has(root(node.expression)) || suites.has(root(node.expression))) &&
      node.arguments.length &&
      !['each', 'for', 'skipIf', 'runIf', 'extend'].includes(
        property(node.expression),
      )
    ) {
      const chain = [
        ...enclosing,
        ...modifiers(node.expression),
        ...optionModifiers(node.arguments),
      ];
      if (chain.some(({ name }) => name === 'only')) hasOnly = true;
      if (names.has(root(node.expression))) {
        const title = node.arguments[0];
        cases.push({
          title: ts.isStringLiteralLike(title) ? title.text : print(title),
          modifiers: chain,
        });
      } else {
        // Only the suite callback inherits its modifiers, not data/conditions.
        for (const argument of node.arguments)
          visit(
            argument,
            ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
              ? chain
              : enclosing,
          );
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, enclosing));
  };
  visit(source);
  return { cases, hasOnly };
}

// Unknown conditions are conservative: preserving one is allowed, but adding or
// changing one may disable coverage. `only` also narrows the executed test set.
function restrictions(test) {
  return new Set(
    test.modifiers.flatMap(({ name, condition }) => {
      if (['skip', 'todo', 'only'].includes(name))
        return [condition === undefined ? name : `${name}(${condition})`];
      if (!['skipIf', 'runIf'].includes(name)) return [];
      if (
        (name === 'skipIf' && condition === 'false') ||
        (name === 'runIf' && condition === 'true')
      )
        return [];
      if (
        (name === 'skipIf' && condition === 'true') ||
        (name === 'runIf' && condition === 'false')
      )
        return ['skip'];
      return [`${name}(${condition})`];
    }),
  );
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
    let afterDeclarations;
    try {
      afterDeclarations = testDeclarations(path, after);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      violations.push(
        `${path}: cannot inspect test declarations: invalid syntax.`,
      );
      continue;
    }
    if (before === null) continue;
    const remaining = afterDeclarations.cases;
    const beforeDeclarations = testDeclarations(path, before);
    const previous = beforeDeclarations.cases;
    const beforeRestrictions = previous.map(restrictions);
    const afterRestrictions = remaining.map(restrictions);
    const matched = new Map();
    // Match compatible duplicates first, allowing reassignment rather than
    // letting declaration order hide a newly disabled case.
    const match = (index, seen) => {
      for (let next = 0; next < remaining.length; next++) {
        if (
          seen.has(next) ||
          previous[index].title !== remaining[next].title ||
          ![...afterRestrictions[next]].every((restriction) =>
            beforeRestrictions[index].has(restriction),
          )
        )
          continue;
        seen.add(next);
        if (!matched.has(next) || match(matched.get(next), seen)) {
          matched.set(next, index);
          return true;
        }
      }
      return false;
    };
    for (let index = 0; index < previous.length; index++)
      match(index, new Set());
    const preserved = new Set(matched.values());
    const unmatched = remaining.filter((_, index) => !matched.has(index));
    const violationCount = violations.length;
    for (let index = 0; index < previous.length; index++) {
      if (preserved.has(index)) continue;
      const { title } = previous[index];
      const next = unmatched.findIndex((test) => test.title === title);
      if (next >= 0) {
        unmatched.splice(next, 1);
        violations.push(
          `${path}: disabled or restricted test case ${JSON.stringify(title)}; restore the existing execution modifiers.`,
        );
      } else
        violations.push(
          `${path}: removed test case ${JSON.stringify(title)}; restore the existing case.`,
        );
    }
    if (
      afterDeclarations.hasOnly &&
      !beforeDeclarations.hasOnly &&
      violations.length === violationCount
    )
      violations.push(
        `${path}: introducing only in an existing test file restricts other test cases; restore the existing execution modifiers.`,
      );
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
