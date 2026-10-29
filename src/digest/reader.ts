import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestRow, ReadNight } from './types.js';

type Event = {
  at: string;
  job: string;
  status: DigestRow['lastStatus'];
  owner: string | null;
  error?: string;
};

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}

function validTimestamp(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !validDate(match[1])) return false;
  const zone = match[5];
  return Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4]) < 60
    && (zone === 'Z' || (Number(zone.slice(1, 3)) < 24 && Number(zone.slice(4)) < 60))
    && Number.isFinite(Date.parse(value));
}

function isEvent(value: unknown): value is Event {
  if (typeof value !== 'object' || value === null) return false;
  return 'at' in value && typeof value.at === 'string' && validTimestamp(value.at)
    && 'job' in value && typeof value.job === 'string' && value.job.trim().length > 0
    && 'status' in value && (value.status === 'ok' || value.status === 'retry' || value.status === 'fail')
    && 'owner' in value && (value.owner === null || typeof value.owner === 'string')
    && (!('error' in value) || typeof value.error === 'string');
}

export const readNight: ReadNight = (runsDir, night) => {
  if (!validDate(night)) return null;
  let contents: string;
  try {
    contents = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }

  const counts = { ok: 0, retry: 0, fail: 0 };
  const jobs = new Map<string, { row: DigestRow; first: number; last: number; errorAt: number }>();
  let badLines = 0;
  const lines = contents === '' ? [] : contents.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      badLines++;
      continue;
    }
    if (!isEvent(event)) {
      badLines++;
      continue;
    }
    counts[event.status]++;
    const at = Date.parse(event.at);
    const current = jobs.get(event.job);
    if (!current) {
      jobs.set(event.job, {
        row: {
          job: event.job, owner: event.owner, runs: 1,
          retries: event.status === 'retry' ? 1 : 0,
          lastStatus: event.status, lastError: event.error ?? null,
          firstAt: event.at, lastAt: event.at,
        },
        first: at, last: at, errorAt: event.error === undefined ? -Infinity : at,
      });
      continue;
    }
    const { row } = current;
    row.runs++;
    if (event.status === 'retry') row.retries++;
    if (at < current.first) {
      current.first = at;
      row.firstAt = event.at;
    }
    if (at >= current.last) {
      current.last = at;
      row.lastAt = event.at;
      row.lastStatus = event.status;
      row.owner = event.owner;
    }
    if (event.error !== undefined && at >= current.errorAt) {
      current.errorAt = at;
      row.lastError = event.error;
    }
  }
  const rows = [...jobs.values()].map(({ row }) => row)
    .sort((a, b) => a.job < b.job ? -1 : a.job > b.job ? 1 : 0);
  return { night, rows, badLines, counts };
};
