/** Run legacy regression suites with isolated DB, manuscript mirror and recovery roots. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowed = ['test:regression', 'test:e2e', 'test:e2e:browser', 'test:e2e:mobile', 'test:e2e:theme', 'test:pg-lease'];
const selected = process.argv.slice(2);
const suites = selected.length ? selected : allowed;
if (suites.some(name => !allowed.includes(name))) throw Error('Unknown isolated audit suite');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'molan-full-regression-'));
const results = [];
for (const name of suites) {
  const dir = path.join(out, name.replaceAll(':', '-')); fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(path.join(dir, 'audit.log'), 'w');
  const env = { ...process.env, MOLAN_AUDIT_OUTPUT: path.join(dir, 'screenshots'), MOLAN_DATA_DIR: path.join(dir, 'data'), MOLAN_SQLITE_PATH: path.join(dir, 'isolated.sqlite'), MOLAN_SECRET: 'full-regression-isolated-secret-only', DATABASE_URL: '', MOLAN_DB: '', CHANGJUAN_DB: '', MOLAN_NATIVE_PG: '', MOLAN_LEASE_DATABASE_URL: 'postgres://audit:audit@127.0.0.1:1/audit_unreachable', MOLAN_API_KEY: '', OPENAI_API_KEY: '', OPENAI_BASE_URL: '', MOLAN_BASE_URL: '', MOLAN_AGENT_RUNTIME: 'local', CHANGJUAN_AGENT_RUNTIME: '', EAZO_APP_AI_API_BASE: '', EAZO_PRIVATE_KEY: '', MOLAN_ACCESS_TOKEN: '' };
  console.log(`RUN ${name} (isolated data root)`);
  const child = spawn('npm', ['run', name], { cwd: root, env, stdio: ['ignore', log, log], detached: true });
  const timer = setTimeout(() => { if (child.pid) try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, 240000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timer); fs.closeSync(log);
  const text = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8');
  const tail = text.split('\n').filter(x => /\d+\/\d+ passed|Failed:|Error:|PASS.*跳过|SKIP/i.test(x)).slice(-10);
  console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${name} exit=${code}\n${tail.join('\n')}`);
  results.push({ suite: name, code, log: path.join(dir, 'audit.log') });
}
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(`Internal audit records: ${out}`);
if (results.some(r => r.code !== 0)) process.exitCode = 1;
