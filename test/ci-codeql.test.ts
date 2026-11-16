/** Preserve PR-time analysis for executable tracker files. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseDocument } from 'yaml';

/** Inert tracker data a pull request can change without touching executable code. */
const INERT_TRACKER_PATHS = ['.agents/pm/tasks/a.toon', '.agents/pm/history/a.jsonl', '.agents/pm/settings.json'];

/** GitHub's runner matches hidden path components with wildcards (dot: true);
 *  Node's matchesGlob does not, so `**` never selects `.agents/...` for it and
 *  the tracker exclusion would be untestable through it. Model GitHub's
 *  dot-compatible behavior: `**` matches zero or more path components
 *  including dot-leading ones, `*` matches within one component. */
function githubMatches(path: string, pattern: string): boolean {
  const segments = path.split('/');
  const parts = pattern.split('/');
  const match = (s: number, p: number): boolean => {
    if (p === parts.length) return s === segments.length;
    if (parts[p] === '**') {
      for (let skip = s; skip <= segments.length; skip++) if (match(skip, p + 1)) return true;
      return false;
    }
    if (s === segments.length) return false;
    const expression = new RegExp(`^${parts[p].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
    return expression.test(segments[s]) && match(s + 1, p + 1);
  };
  return match(0, 0);
}

/** Ordered path-filter routing: the last matching pattern decides, starting unselected. */
function routes(path: string, patterns: string[]): boolean {
  return patterns.reduce((selected, pattern) => githubMatches(path, pattern.replace(/^!/, '')) ? !pattern.startsWith('!') : selected, false);
}

function workflowPaths(event: string): string[] {
  const document = parseDocument(readFileSync('.github/workflows/codeql.yml', 'utf8'), { strict: true, uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const patterns: string[] = document.toJS().on[event].paths;
  assert.ok(Array.isArray(patterns) && patterns.length > 0, `${event} must declare ordered paths`);
  return patterns;
}

test('CodeQL filters inert data and re-includes every executable tracker extension', () => {
  for (const event of ['push', 'pull_request']) {
    const patterns = workflowPaths(event);
    for (const [path, expected] of [
      ...['js', 'mjs', 'cjs', 'ts'].flatMap(extension => [`.agents/pm/check.${extension}`, `.agents/pm/nested/check.${extension}`].map(path => [path, true] as const)),
      ...INERT_TRACKER_PATHS.map(path => [path, false] as const),
      ['README.md', false], ['docs/example.json', false], ['package-lock.json', false], ['index.ts', true],
    ] as const) {
      assert.equal(routes(path, patterns), expected, path);
    }
  }
});

test('the tracker exclusion is load-bearing: removing it routes inert tracker data to CodeQL', () => {
  for (const event of ['push', 'pull_request']) {
    const patterns = workflowPaths(event);
    const mutated = patterns.filter(pattern => pattern !== '!.agents/pm/**');
    assert.notDeepEqual(mutated, patterns, 'the mutation must actually remove the exclusion');
    for (const path of INERT_TRACKER_PATHS) {
      assert.equal(routes(path, mutated), true, `without the exclusion, ${path} would be analyzed`);
    }
  }
});
