import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inlineMarkdownLinkPattern,
  stripHtmlTags,
} from './verify-docs-parser.mjs';

test('inline Markdown links retain supported escaping and nested parentheses', () => {
  const source = String.raw`[one](docs/a\ file.md) [two](docs/(nested).md "title")`;
  const matches = [...source.matchAll(inlineMarkdownLinkPattern)];

  assert.deepEqual(matches.map((match) => match[2] ?? match[3]), [
    String.raw`docs/a\ file.md`,
    'docs/(nested).md',
  ]);
});

test('inline Markdown link matching handles a long unmatched escape sequence', () => {
  const source = `[label](${String.raw`\!`.repeat(20_000)}`;

  assert.deepEqual([...source.matchAll(inlineMarkdownLinkPattern)], []);
});

test('HTML tag stripping cannot recreate a nested tag sequence', () => {
  assert.equal(stripHtmlTags('<scr<script>ipt>alert</script>'), 'ipt>alert');
  assert.equal(stripHtmlTags('before <em>inside</em> after'), 'before inside after');
});
