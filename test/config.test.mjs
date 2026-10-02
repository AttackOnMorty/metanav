import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalise } from '../scripts/lib/config.mjs';

const minimal = { user: { name: 'Jane Doe', short_name: 'Jane' }, github: { org: 'acme' } };

test('Azure DevOps organisations, by name or by link, come out as their links', () => {
  const c = normalise({ ...minimal, azure_devops: { orgs: ['contoso', 'https://dev.azure.com/fabrikam/Project/_git/x'] } });
  assert.deepEqual(c.azure_devops.orgs, ['https://dev.azure.com/contoso', 'https://dev.azure.com/fabrikam']);
});

test('what the file leaves out takes its default', () => {
  const c = normalise({ ...minimal, schedule: { every_minutes: 30 } });
  assert.deepEqual({ schedule: c.schedule, judge: c.judge, lookback_days: c.lookback_days, teams: c.teams, mail: c.mail, orgs: c.azure_devops.orgs }, {
    schedule: { every_minutes: 30, start_hour: 9, end_hour: 18 },
    judge: { agent: 'claude', model: 'opus' },
    lookback_days: 30,
    teams: { skip_chats: [] },
    mail: { received_folders: [{ name: 'Inbox', url: 'https://outlook.office.com/mail/inbox' }] },
    orgs: [],
  });
});

test('Codex keeps its own default model when the config names a Claude one', () => {
  assert.deepEqual(normalise({ ...minimal, judge: { agent: 'codex', model: 'opus' } }).judge, { agent: 'codex', model: '' });
  assert.deepEqual(normalise({ ...minimal, judge: { agent: 'codex', model: 'gpt-5.5' } }).judge, { agent: 'codex', model: 'gpt-5.5' });
});

test('a config without who the user is or their GitHub organisation is refused, by name', () => {
  assert.throws(() => normalise({ github: { org: 'acme' } }), /user\.name/);
  assert.throws(() => normalise({ user: { name: 'Jane Doe' } }), /github\.org/);
});
