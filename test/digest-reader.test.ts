import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/reader.js';

const night = '2026-10-28';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rig-digest-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const event = (changes: Record<string, unknown> = {}) => ({
  at: '2026-10-28T23:00:00+01:00', job: 'job', status: 'ok', owner: null, ...changes,
});
function write(events: unknown[]) {
  writeFileSync(join(dir, `${night}.jsonl`), events.map(item => JSON.stringify(item)).join('\n'));
}

describe('readNight', () => {
  it('reads the unchanged real fixture, preserving every job and historical errors', () => {
    const fixture = new URL('../runs/2026-10-28.jsonl', import.meta.url);
    const before = readFileSync(fixture);
    const result = readNight(new URL('../runs/', import.meta.url).pathname, night);
    expect(result).toMatchObject({ night, badLines: 1, counts: { ok: 10, retry: 4, fail: 1 } });
    expect(result?.rows.map(row => row.job)).toEqual([
      'digest/render', 'fixtures/refresh', 'lane/sync', 'notes/backup', 'rig/rotate-logs',
    ]);
    expect(result?.rows[0]).toMatchObject({ owner: null, runs: 1, lastError: null });
    expect(result?.rows[1]).toEqual({
      job: 'fixtures/refresh', owner: 'rook', runs: 4, retries: 3,
      lastStatus: 'ok', lastError: 'upstream 503',
      firstAt: '2026-10-29T01:30:00+01:00', lastAt: '2026-10-29T01:37:00+01:00',
    });
    expect(result?.rows[2]).toMatchObject({ runs: 8, retries: 1, lastError: 'lock held' });
    expect(result?.rows[3]).toMatchObject({ lastStatus: 'fail', lastError: 'quota exceeded' });
    expect(readFileSync(fixture)).toEqual(before);
  });

  it('distinguishes missing, empty, malformed and non-file inputs', () => {
    expect(readNight(dir, night)).toBeNull();
    writeFileSync(join(dir, `${night}.jsonl`), '');
    expect(readNight(dir, night)).toEqual({ night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
    writeFileSync(join(dir, `${night}.jsonl`), '{broken\n');
    expect(readNight(dir, night)?.badLines).toBe(1);
    rmSync(join(dir, `${night}.jsonl`));
    mkdirSync(join(dir, `${night}.jsonl`));
    expect(() => readNight(dir, night)).toThrow();
  });

  it.each(['../2026-10-28', '/2026-10-28', '2026-02-29', '2026-13-01', '2026-1-01', '2026-10-28.jsonl'])('rejects invalid night %s', value => {
    expect(readNight(dir, value)).toBeNull();
  });

  it('accepts leap days', () => {
    writeFileSync(join(dir, '2024-02-29.jsonl'), JSON.stringify(event({ at: '2024-02-29T00:00:00Z' })));
    expect(readNight(dir, '2024-02-29')?.rows).toHaveLength(1);
  });

  it('counts invalid schemas, preserving valid rows including prototype-like job names', () => {
    const { owner: omitted, ...missingOwner } = event();
    write([null, [], 42, {}, missingOwner, event({ owner: 5 }), event({ job: '' }),
      event({ status: 'unknown' }), event({ error: null }), event({ at: '2026-02-30T00:00:00Z' }),
      event({ at: '2026-10-28T24:00:00Z' }), event({ at: '2026-10-28T00:00:00' }),
      event({ at: '2026-10-28T00:00:00+25:00' }), event({ job: '__proto__' }), event({ job: 'constructor' })]);
    expect(readNight(dir, night)).toMatchObject({ badLines: 13, counts: { ok: 2, retry: 0, fail: 0 } });
    expect(readNight(dir, night)?.rows.map(row => row.job)).toEqual(['__proto__', 'constructor']);
  });

  it('compares instants across offsets and out-of-order records, retaining the latest error', () => {
    write([
      event({ at: '2026-10-28T23:00:00Z', owner: 'latest' }),
      event({ at: '2026-10-29T01:30:00+03:00', status: 'retry', error: 'new error' }),
      event({ at: '2026-10-28T22:00:00+01:00', status: 'fail', error: 'old error', owner: 'old' }),
    ]);
    expect(readNight(dir, night)?.rows[0]).toEqual({
      job: 'job', owner: 'latest', runs: 3, retries: 1, lastStatus: 'ok', lastError: 'new error',
      firstAt: '2026-10-28T22:00:00+01:00', lastAt: '2026-10-28T23:00:00Z',
    });
  });

  it('uses the later line on tied instants and retains null owners and empty error strings', () => {
    write([event({ status: 'fail', owner: 'old', error: 'old' }), event({ status: 'retry', error: '' }), event()]);
    expect(readNight(dir, night)?.rows[0]).toMatchObject({ owner: null, lastStatus: 'ok', lastError: '', runs: 3, retries: 1 });
  });

  it('handles CRLF and ignores only the final newline, counting internal blanks', () => {
    writeFileSync(join(dir, `${night}.jsonl`), `${JSON.stringify(event())}\r\n\r\n${JSON.stringify(event({ job: 'other' }))}\r\n`);
    expect(readNight(dir, night)).toMatchObject({ badLines: 1, counts: { ok: 2, retry: 0, fail: 0 } });
  });
});
