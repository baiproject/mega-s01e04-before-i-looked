import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { NightDigest } from '../src/digest/types.js';

const night = '2026-10-28';
const firstAt = '2026-10-28T01:00:00+02:00';
const lastAt = '2026-10-28T03:00:00+02:00';
const paths = [`/digest/${night}`, `/api/digest/${night}`];

// Decode text only after stripping markup, so escaped user input stays text.
function textContent(markup: string): string {
  return markup.replace(/<[^>]*>/g, '').replace(
    /&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi,
    (entity) => {
      const named: Record<string, string> = {
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
      };
      if (entity.startsWith('&#')) {
        const hex = entity[2].toLowerCase() === 'x';
        return String.fromCodePoint(Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10));
      }
      return named[entity.toLowerCase()] ?? entity;
    },
  ).trim();
}

function tableRows(html: string): string[][] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .filter((row) => /<td\b/i.test(row[1]))
    .map((row) => [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((cell) => textContent(cell[1])))
    .filter((cells) => cells.length > 0);
}

describe('digest routes through the application', () => {
  let temporaryDir: string;
  let runsDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(join(tmpdir(), 'rig-digest-routes-'));
    runsDir = join(temporaryDir, 'runs');
    mkdirSync(runsDir);
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  function app() {
    return createApp({ adapter: 'shim', installed: firstAt, beatEverySeconds: 60, runsDir });
  }

  function writeNight(lines: unknown[]) {
    writeFileSync(join(runsDir, `${night}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  }

  async function readBoth(expected: NightDigest) {
    const application = app();
    const htmlResponse = await application.request(paths[0]);
    const jsonResponse = await application.request(paths[1]);
    expect(htmlResponse.status).toBe(200);
    expect(jsonResponse.status).toBe(200);
    expect(htmlResponse.headers.get('content-type')).toContain('text/html');
    expect(jsonResponse.headers.get('content-type')).toContain('application/json');
    expect(await jsonResponse.json()).toEqual(expected);
    const html = await htmlResponse.text();
    const rows = tableRows(html);
    if (expected.rows.length > 0) expect(rows).toHaveLength(expected.rows.length);
    for (const [index, row] of expected.rows.entries()) {
      const cells = rows[index];
      // Check row order and every displayed field without coupling to column order/classes.
      for (const value of [row.job, row.owner ?? '—', String(row.runs), String(row.retries),
        row.lastStatus, row.firstAt, row.lastAt]) {
        expect(cells).toContain(value);
      }
      if (row.lastError !== null) expect(cells.join(' ')).toContain(row.lastError);
      const missing = Number(row.owner === null) + Number(row.lastError === null);
      expect(cells.filter((cell) => cell === '—').length).toBeGreaterThanOrEqual(missing);
    }
    return html;
  }

  it('serves sorted rows with event counts, retries, null owner and original timestamp offsets', async () => {
    writeNight([
      { at: firstAt, job: 'zeta', owner: null, status: 'fail', error: 'disk unavailable' },
      { at: lastAt, job: 'alpha', owner: 'rook', status: 'ok' },
      { at: firstAt, job: 'alpha', owner: 'old-owner', status: 'retry', error: 'try again' },
    ]);
    await readBoth({ night, badLines: 0, counts: { ok: 1, retry: 1, fail: 1 }, rows: [
      { job: 'alpha', owner: 'rook', runs: 2, retries: 1, lastStatus: 'ok', lastError: 'try again', firstAt, lastAt },
      { job: 'zeta', owner: null, runs: 1, retries: 0, lastStatus: 'fail', lastError: 'disk unavailable', firstAt, lastAt: firstAt },
    ] });
  });

  it.each(paths)('returns 404 for a missing night at %s', async (path) => {
    expect((await app().request(path)).status).toBe(404);
  });

  it('renders an existing empty night and returns an empty JSON digest', async () => {
    writeFileSync(join(runsDir, `${night}.jsonl`), '');
    const html = await readBoth({ night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
    expect(textContent(html).toLowerCase()).toContain('nothing ran');
  });

  it('keeps valid rows and counts malformed JSON and invalid schema lines', async () => {
    const valid = { at: firstAt, job: 'survivor', owner: null, status: 'ok' };
    writeFileSync(join(runsDir, `${night}.jsonl`),
      `${JSON.stringify(valid)}\n{broken\n${JSON.stringify({ ...valid, status: 'unknown' })}\n`);
    await readBoth({ night, badLines: 2, counts: { ok: 1, retry: 0, fail: 0 }, rows: [
      { job: 'survivor', owner: null, runs: 1, retries: 0, lastStatus: 'ok', lastError: null, firstAt, lastAt: firstAt },
    ] });
  });

  it('serves an all-malformed night without pretending the file is missing', async () => {
    writeFileSync(join(runsDir, `${night}.jsonl`), '{broken\nnull\n');
    await readBoth({ night, rows: [], badLines: 2, counts: { ok: 0, retry: 0, fail: 0 } });
  });

  it('escapes job, owner and error in HTML while preserving their JSON values', async () => {
    const job = '<script>alert("job")</script>';
    const owner = '<img src=x onerror="alert(1)">';
    const error = '<svg onload="alert(2)"> & "failure"';
    writeNight([{ at: firstAt, job, owner, status: 'fail', error }]);
    const html = await readBoth({ night, badLines: 0, counts: { ok: 0, retry: 0, fail: 1 }, rows: [
      { job, owner, runs: 1, retries: 0, lastStatus: 'fail', lastError: error, firstAt, lastAt: firstAt },
    ] });
    expect(html).not.toMatch(/<(?:script|img|svg)\b/i);
    for (const raw of [job, owner, error]) expect(html).not.toContain(raw);
  });

  it.each(['not-a-night', '2026-02-30', '2026-13-01', '2026-1-01', '..%2Foutside'])
    ('rejects invalid night %s on both routes even when a corresponding file exists', async (invalid) => {
      // A readable decoy catches implementations that only check whether a file exists.
      const filename = invalid.includes('%') ? 'outside' : invalid;
      writeFileSync(join(invalid.includes('%') ? temporaryDir : runsDir, `${filename}.jsonl`), '');
      for (const prefix of ['/digest/', '/api/digest/']) {
        expect((await app().request(prefix + invalid)).status).toBe(404);
      }
    });
});
