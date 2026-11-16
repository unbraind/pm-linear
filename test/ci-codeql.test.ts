/** Preserve PR-time analysis for executable tracker files. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import test from 'node:test';
import { parseDocument } from 'yaml';

test('CodeQL filters inert data and re-includes every executable tracker extension', () => {
  const document = parseDocument(readFileSync('.github/workflows/codeql.yml', 'utf8'), { strict: true, uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const workflow = document.toJS();
  for (const event of ['push', 'pull_request']) {
    const patterns: string[] = workflow.on[event].paths;
    for (const [path, expected] of [
      ...['js', 'mjs', 'cjs', 'ts'].flatMap(extension => [`.agents/pm/check.${extension}`, `.agents/pm/nested/check.${extension}`].map(path => [path, true] as const)),
      ['README.md', false], ['docs/example.json', false], ['package-lock.json', false],
      ['.agents/pm/tasks/a.toon', false], ['.agents/pm/history/a.jsonl', false], ['.agents/pm/settings.json', false], ['index.ts', true],
    ] as const) {
      assert.equal(patterns.reduce((selected, pattern) => matchesGlob(path, pattern.replace(/^!/, '')) ? !pattern.startsWith('!') : selected, false), expected, path);
    }
  }
});
