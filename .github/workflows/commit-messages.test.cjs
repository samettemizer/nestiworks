const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const workflow = readFileSync(`${__dirname}/commit-messages.yml`, 'utf8');
const script = workflow.split('          script: |\n')[1].replace(/^            /gm, '');
const run = new (Object.getPrototypeOf(async function () {}).constructor)('github', 'context', 'core', script);

async function check(messages, count = messages.length) {
  const failures = [];
  await run({
    rest: { pulls: { listCommits: 'listCommits' } },
    paginate: async () => messages.map((message, i) => ({ sha: `${i}abcdef123`, commit: { message } })),
  }, {
    repo: { owner: 'example', repo: 'example' },
    payload: { pull_request: { number: 1, commits: count } },
  }, { setFailed: message => failures.push(message) });
  return failures;
}

test('accepts all allowed types, scopes, breaking changes and bodies', async () => {
  const messages = 'feat fix docs style refactor perf test build ci chore revert'.split(' ').map(type => `${type}: update plugin`);
  messages.push('fix(python): correct handoff', 'feat!: change interface', 'feat(api)!: change interface\n\nBREAKING CHANGE: new interface');
  assert.deepEqual(await check(messages), []);
});

test('rejects invalid titles even among valid commits', async () => {
  for (const title of ['update plugin', 'feature: add plugin', 'Fix: bug', 'fix: ', 'fix:  ', 'fix:bug', 'fix(): bug', 'fix(scope: bug']) {
    const failures = await check(['docs: update guide', title]);
    assert.equal(failures.length, 1, title);
    assert.match(failures[0], /1abcdef/, title);
  }
});

test('fails closed when GitHub returns an incomplete commit list', async () => {
  assert.deepEqual(await check(['fix: bug'], 251), ['Could not check every commit. Split this PR into smaller PRs.']);
});
