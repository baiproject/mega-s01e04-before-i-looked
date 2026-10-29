/** One job's validated events, ordered by instant (later line wins ties). */
export type DigestRow = {
  job: string;
  owner: string | null;
  runs: number;
  retries: number;
  lastStatus: 'ok' | 'retry' | 'fail';
  /** Most recent recorded error, retained after a successful retry. */
  lastError: string | null;
  /** Original timestamp strings, including their offsets. */
  firstAt: string;
  lastAt: string;
};

export type NightDigest = {
  night: string;
  /** Sorted by job in ascending code-unit order. */
  rows: DigestRow[];
  badLines: number;
  /** Counts of valid events, not final job statuses. */
  counts: { ok: number; retry: number; fail: number };
};

/**
 * Read <runsDir>/<night>.jsonl synchronously; night is a calendar YYYY-MM-DD.
 * Missing files and invalid nights return null; other I/O errors propagate.
 * Empty files return an empty digest. Invalid JSON/schema lines count as badLines;
 * a terminal newline does not. Timestamps require an explicit timezone.
 */
export type ReadNight = (runsDir: string, night: string) => NightDigest | null;
