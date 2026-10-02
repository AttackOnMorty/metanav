// config.json, read once: every default, check and normalisation in one place, so the rest of Meta-Nav reads
// plain values (config.example.json shows the file; the result keeps its shape, filled in).
import { readFileSync } from 'node:fs';

export function normalise(raw) {
  for (const [path, value] of [['user.name', raw.user?.name], ['github.org', raw.github?.org]]) {
    if (!value) throw new Error(`config.json: ${path} is missing (config.example.json shows it)`);
  }
  const agent = raw.judge?.agent || 'claude';
  // a Claude model name means nothing to Codex: it keeps its own default
  const model = agent === 'codex' ? (/^(opus|sonnet|haiku|claude)/.test(raw.judge?.model || '') ? '' : raw.judge?.model || '') : raw.judge?.model || 'opus';
  return {
    ...raw,
    // each organisation by name ("contoso"), or its https://dev.azure.com/contoso link
    azure_devops: { orgs: (raw.azure_devops?.orgs || []).map(o => `https://dev.azure.com/${String(o).replace(/^https:\/\/dev\.azure\.com\//, '').split('/')[0]}`) },
    mail: { received_folders: raw.mail?.received_folders?.length ? raw.mail.received_folders : [{ name: 'Inbox', url: 'https://outlook.office.com/mail/inbox' }] },
    teams: { skip_chats: raw.teams?.skip_chats || [] },
    // scheduled syncs: every so many minutes, on weekdays between these hours
    schedule: { every_minutes: 60, start_hour: 9, end_hour: 18, ...raw.schedule },
    judge: { agent, model },
    // how far back open loops reach
    lookback_days: raw.lookback_days ?? 30,
  };
}

export const readConfig = file => normalise(JSON.parse(readFileSync(file, 'utf8')));
