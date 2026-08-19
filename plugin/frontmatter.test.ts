import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFrontmatterUpdates } from './frontmatter.ts';

const ARTICLE = `---
scheduled: "2026-08-18T12:00:00+09:00"
status: review
title: "Fable5一辺倒？格安LLMを侮るなかれ"
source_note: "8/3実績で約2660万トークン・$0.85、従来AIムービーパイプラインは1回$15。noteリライト。"
policy_note: "コスト数字は約2660万トークン/$0.85を正とする。"
source_primary: "[[2026-08-03_AI、マジで多様化時代に突入した。_SZ50P34K]]"
---

# Fable5だけ。はもう古い。
`;

test('preserves $15 and $0.85 when adding x_status', () => {
    const next = applyFrontmatterUpdates(ARTICLE, { x_status: 'publishing', x_error: '' });

    assert.match(next, /1回\$15。/);
    assert.match(next, /\$0\.85/);
    assert.match(next, /x_status: publishing/);
    assert.match(next, /x_error: ""/);
    assert.equal((next.match(/^---$/gm) || []).length, 2);
    assert.doesNotMatch(next, /1回scheduled:/);
    assert.doesNotMatch(next, /deepseek\.com\/"5。/);
});

test('does not interpret $&, $\', $` or $$ in existing values', () => {
    const src = `---
note: "price $& and after $' and before $\` and dollar $$"
---

body
`;
    const next = applyFrontmatterUpdates(src, { x_status: 'published' });
    assert.match(next, /price \$& and after \$' and before \$` and dollar \$\$/);
    assert.match(next, /x_status: published/);
    assert.equal(next.includes('body'), true);
});

test('updates an existing x_status line instead of duplicating it', () => {
    const src = `---
x_status: publishing
title: hello
---

text
`;
    const next = applyFrontmatterUpdates(src, { x_status: 'review', x_error: 'Unexpected end of JSON input' });
    assert.equal((next.match(/x_status:/g) || []).length, 1);
    assert.match(next, /x_status: review/);
    assert.match(next, /x_error: Unexpected end of JSON input/);
});

test('prepends frontmatter when the note has none', () => {
    const next = applyFrontmatterUpdates('# hello\n', { x_status: 'published' });
    assert.equal(next.startsWith('---\n'), true);
    assert.match(next, /x_status: published/);
    assert.match(next, /# hello/);
});
