/**
 * Sequential batch execution shared by media commands.
 *
 * Sequential is deliberate: image/video encoding is already CPU-bound, and a
 * stable order makes output and tests deterministic.
 */

export interface BatchFailure {
  readonly input: string;
  readonly error: string;
}

export interface BatchResult<T> {
  readonly results: readonly T[];
  readonly failures: readonly BatchFailure[];
  readonly aborted: boolean;
}

export interface BatchOptions {
  readonly signal?: AbortSignal;
  readonly onStart?: (input: string, index: number, total: number) => void;
}

export async function runBatch<I, R>(
  items: readonly I[],
  worker: (item: I, index: number) => Promise<R>,
  inputOf: (item: I) => string,
  options: BatchOptions = {},
): Promise<BatchResult<R>> {
  const results: R[] = [];
  const failures: BatchFailure[] = [];
  let aborted = false;

  for (const [index, item] of items.entries()) {
    if (options.signal?.aborted) {
      aborted = true;
      break;
    }
    const input = inputOf(item);
    options.onStart?.(input, index, items.length);
    try {
      results.push(await worker(item, index));
    } catch (error) {
      failures.push({ input, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { results, failures, aborted };
}

/** Totals used by the shared media summary. */
export function sizeTotals(
  results: readonly { readonly before: number; readonly after: number }[],
): { readonly before: number; readonly after: number } {
  let before = 0;
  let after = 0;
  for (const result of results) {
    before += result.before;
    after += result.after;
  }
  return { before, after };
}
