// The skills are routers into PROTOCOL.md: every section a table row names
// must exist, or the pointer sends an agent nowhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(p, 'utf-8').replace(/\r/g, '');
const headings = new Set([...read('skills/PROTOCOL.md').matchAll(/^## (.+)$/gm)].map((m) => m[1].trim()));

for (const h of ['claude', 'codex', 'omp']) {
  test(`peer-${h} points only at sections PROTOCOL.md has`, () => {
    const skill = read(`skills/peer-${h}/SKILL.md`);
    const cells = [...skill.matchAll(/\| ([^|\n]+) \|\n/g)].map((m) => m[1]).filter((c) => c !== 'PROTOCOL.md section' && c !== '---');
    const inline = [...skill.matchAll(/\(PROTOCOL: ([^)]+)\)/g)].map((m) => m[1]);
    const refs = [...cells.flatMap((c) => c.replace(/\s*\(.*\)\s*$/, '').split(';')), ...inline].map((s) => s.trim());
    for (const r of refs) assert.ok(headings.has(r), `"${r}" is not a PROTOCOL.md heading`);
  });
}

// The frontmatter is YAML: an unquoted value holding ": " does not parse, and
// Claude Code then lists the skill by its H1 with no description, so it stops
// triggering. Seen 2026-10-12 after "peer: a second opinion" went in.
for (const h of ['claude', 'codex', 'omp']) {
  test(`peer-${h}'s frontmatter is plain YAML: name, a one-line description, no bare ": " in a value`, () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(read(`skills/peer-${h}/SKILL.md`))?.[1];
    assert.ok(front, 'frontmatter between --- lines');
    const fields = Object.fromEntries(front.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
    assert.equal(fields.name, `peer-${h}`);
    assert.ok(fields.description?.length > 40, 'a description');
    for (const [key, value] of Object.entries(fields)) {
      assert.ok(/^["']/.test(value) || !/: /.test(value), `${key}: an unquoted value holds ": ", which YAML refuses`);
    }
  });
}

test('omp-advisor points only at sections PROTOCOL.md has, stays short, and has plain YAML frontmatter', () => {
  const skill = read('skills/omp-advisor/SKILL.md');
  const cells = [...skill.matchAll(/\| ([^|\n]+) \|\n/g)].map((m) => m[1]).filter((c) => c !== 'PROTOCOL.md section' && c !== '---');
  const inline = [...skill.matchAll(/\(PROTOCOL: ([^)]+)\)/g)].map((m) => m[1]);
  const refs = [...cells.flatMap((c) => c.replace(/\s*\(.*\)\s*$/, '').split(';')), ...inline].map((s) => s.trim());
  assert.ok(refs.length >= 4, `expected a pointer table, found ${refs.length} refs`);
  for (const r of refs) assert.ok(headings.has(r), `"${r}" is not a PROTOCOL.md heading`);
  assert.ok(refs.includes('Advisor'), 'the detail lives in the Advisor section');
  assert.ok(skill.split('\n').length < 100, 'a router stays short; detail goes in the protocol');
  const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1];
  assert.ok(front, 'frontmatter between --- lines');
  const fields = Object.fromEntries(front.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
  assert.equal(fields.name, 'omp-advisor');
  assert.ok(fields.description?.length > 40, 'a description');
  for (const [key, value] of Object.entries(fields)) assert.ok(/^["']/.test(value) || !/: /.test(value), `${key}: an unquoted value holds ": ", which YAML refuses`);
});

test('PROTOCOL.md\'s contents line lists its headings, in order', () => {
  const text = read('skills/PROTOCOL.md');
  const listed = /^Contents: ([\s\S]*?)\.\n/m.exec(text)?.[1].replace(/\s+/g, ' ').split(', ').map((s) => s.replace(/^and /, ''));
  assert.deepEqual(listed, [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim()));
});
