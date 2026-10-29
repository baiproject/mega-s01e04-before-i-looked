import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { readStatus } from '../src/status.js';

const config = { adapter: 'shim', installed: '2026-10-29T14:06:00+01:00', beatEverySeconds: 60, runsDir: 'runs' };
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temporaryRuns() {
  const directory = mkdtempSync(join(tmpdir(), 'digest-board-'));
  directories.push(directory);
  return directory;
}

describe('digest links on the status board', () => {
  it('shows both unchanged fixture nights newest first with event totals, not job totals', async () => {
    const status = readStatus(config);
    expect(status.nights).toEqual(['2026-10-28', '2026-10-27']);
    expect(status.nightCounts).toEqual({
      '2026-10-28': { ok: 10, retry: 4, fail: 1 },
      '2026-10-27': { ok: 7, retry: 0, fail: 0 },
    });
    const response = await createApp(config).request('/');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<a href="/digest/2026-10-28">2026-10-28</a> · ok / retry / fail: 10 / 4 / 1');
    expect(html).toContain('<a href="/digest/2026-10-27">2026-10-27</a> · ok / retry / fail: 7 / 0 / 0');
    expect(html.indexOf('/digest/2026-10-28')).toBeLessThan(html.indexOf('/digest/2026-10-27'));
  });

  it('shows zero totals for empty or entirely malformed logs', async () => {
    const runsDir = temporaryRuns();
    writeFileSync(join(runsDir, '2026-10-28.jsonl'), '');
    writeFileSync(join(runsDir, '2026-10-27.jsonl'), 'broken\n{}\n');
    const html = await (await createApp({ ...config, runsDir }).request('/')).text();
    for (const night of ['2026-10-28', '2026-10-27']) {
      expect(html).toContain(`<a href="/digest/${night}">${night}</a> · ok / retry / fail: 0 / 0 / 0`);
    }
  });

  it('preserves the empty directory message and ignores unrelated files', async () => {
    const runsDir = temporaryRuns();
    writeFileSync(join(runsDir, 'notes.txt'), 'not a log');
    const response = await createApp({ ...config, runsDir }).request('/');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('nothing in runs/');
    expect(html).not.toContain('href="/digest/');
  });
});
