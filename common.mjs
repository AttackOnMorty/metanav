// What the runner, the collector and the click store share: the config, where things live on this OS,
// and calls to the command-line tools and web APIs Meta-Nav reads from.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL = dirname(fileURLToPath(import.meta.url));
export const CONFIG = join(SKILL, 'config.json');
export const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
export const OUT = (config.output_dir || '~/metanav').replace(/^~(?=$|[\\/])/, homedir());
export const WIN = process.platform === 'win32';

// The runs' own browser profile, named after the output dir, in this OS's cache folder
const CACHE = WIN ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'metanav')
  : process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches', 'metanav') : join(homedir(), '.cache', 'metanav');
export const PROFILE = join(CACHE, `chrome-${createHash('sha256').update(OUT).digest('hex').slice(0, 7)}`);

// Google Chrome, where its installer puts it
export function chromePath() {
  const places = WIN ? ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].map(v => process.env[v] && join(process.env[v], 'Google', 'Chrome', 'Application', 'chrome.exe'))
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  return places.find(p => p && existsSync(p)) || null;
}

// Run a command-line tool. On Windows, npm-installed tools (codex, az) are .cmd files, which Node only starts through
// the shell - so arguments are quoted for it there. Long text goes in through stdin (`input`), never as an argument.
export function tool(cmd, args = [], opts = {}) {
  const o = { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true, ...opts };   // windowsHide: no console window flashing up
  if (!WIN) return spawnSync(cmd, args, o);
  const q = a => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  return spawnSync([cmd, ...args].map(q).join(' '), { ...o, shell: true });
}

// GitHub, with the token gh is signed in with
let ghTok;
const ghToken = () => (ghTok ??= (tool('gh', ['auth', 'token']).stdout || '').trim());
export async function github(path, body) {
  const r = await fetch(path.startsWith('https://') ? path : `https://api.github.com${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `bearer ${ghToken()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'meta-nav' },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub ${r.status} ${path.slice(0, 80)}`);
  return r.json();
}
export async function graphql(query) {
  const r = await github('/graphql', { query });
  if (!r.data) throw new Error(`GitHub GraphQL: ${JSON.stringify(r.errors || r).slice(0, 200)}`);
  return r.data;
}

// Azure DevOps, with a token for the account az is signed in with (499b84ac-… is Azure DevOps' own resource id)
let adoTok;
const adoToken = () => (adoTok ??= (tool('az', ['account', 'get-access-token', '--resource', '499b84ac-1321-427f-aa17-267ca6975798',
  '--query', 'accessToken', '-o', 'tsv']).stdout || '').trim());
export async function ado(url, body) {
  const token = adoToken();
  if (!token) throw new Error('no Azure DevOps token - run `az login`');
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Azure DevOps ${r.status} ${url.replace(/\?.*/, '').slice(0, 100)}`);
  return r.json();
}
