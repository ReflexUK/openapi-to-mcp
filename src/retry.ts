/**
 * Retry logic and rate limiting for outbound HTTP requests.
 */

/** HTTP status codes that warrant a retry attempt. */
export const RETRYABLE_STATUSES: Set<number> = new Set([429, 502, 503, 504]);

/**
 * Compute exponential back-off delay for attempt n (0-indexed).
 * delay[0] = 200ms, delay[1] = 400ms, delay[2] = 800ms, cap = 10_000ms.
 */
export function computeDelay(attempt: number): number {
  return Math.min(200 * 2 ** attempt, 10_000);
}

export interface RetryOptions {
  /** Maximum number of retry attempts after the initial try. Default 2. */
  maxRetries: number;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs: number;
  /** Fetch implementation (injectable for tests). */
  fetchImpl: typeof fetch;
  /** Override the back-off delay function (injectable for tests, default = computeDelay). */
  delayFn?: (attempt: number) => number;
}

export interface FetchResult {
  response: Response;
  /** Total number of attempts made, including the successful (or final) one. */
  attempts: number;
}

/**
 * Wrap fetch with per-attempt timeouts and retry logic.
 *
 * - Each attempt gets its own AbortController set to abort after `timeoutMs`.
 * - Retries on any status in `RETRYABLE_STATUSES` up to `maxRetries` times.
 * - Back-off delay between retries comes from `delayFn ?? computeDelay`.
 * - `attempts` counts every try, including the final successful or timed-out one.
 * - If the last attempt times out, the timeout error is rethrown.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions,
): Promise<FetchResult> {
  const { maxRetries, timeoutMs, fetchImpl, delayFn } = options;
  const backoff = delayFn ?? computeDelay;

  let attempts = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    attempts += 1;

    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });

      clearTimeout(timer);

      // If not a retryable status, or we've exhausted retries, return the response.
      if (!RETRYABLE_STATUSES.has(response.status) || attempt >= maxRetries) {
        return { response, attempts };
      }

      // Wait before the next retry.
      const delay = backoff(attempt);
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    } catch (err) {
      clearTimeout(timer);
      lastError = err;

      // If we've used up all retries, rethrow.
      if (attempt >= maxRetries) {
        throw err;
      }

      // Only retry on abort (timeout); propagate other errors immediately.
      const isAbort =
        err instanceof Error && err.name === "AbortError";
      if (!isAbort) {
        throw err;
      }

      // Timed out — wait and try again.
      const delay = backoff(attempt);
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // Should never be reached, but TypeScript needs a return / throw here.
  throw lastError ?? new Error("fetchWithRetry: exhausted all attempts");
}

export interface RateLimiterOptions {
  /** Number of requests to allow per second. */
  requestsPerSecond: number;
}

/**
 * Token-bucket rate limiter backed by a queue and a setInterval tick.
 *
 * Each call to `acquire()` enqueues a resolver. Every `1000/rps` ms the
 * interval fires, dequeues one resolver, and resolves it with the elapsed
 * wait time in milliseconds.
 */
export class RateLimiter {
  private readonly queue: Array<(waited: number) => void> = [];
  private readonly intervalHandle: ReturnType<typeof setInterval>;
  private readonly intervalMs: number;

  constructor(options: RateLimiterOptions) {
    this.intervalMs = 1000 / options.requestsPerSecond;

    this.intervalHandle = setInterval(() => {
      const resolve = this.queue.shift();
      if (resolve !== undefined) {
        resolve(this.intervalMs);
      }
    }, this.intervalMs);

    // Allow the Node.js event loop to exit even if the interval is still running.
    if (
      typeof this.intervalHandle === "object" &&
      this.intervalHandle !== null &&
      "unref" in this.intervalHandle
    ) {
      (this.intervalHandle as NodeJS.Timeout).unref();
    }
  }

  /**
   * Acquire a rate-limit token.
   * Resolves immediately if there is capacity, or after the next tick if the
   * queue is busy.  Returns the number of milliseconds waited.
   */
  acquire(): Promise<number> {
    return new Promise<number>((resolve) => {
      const enqueuedAt = Date.now();
      this.queue.push(() => resolve(Date.now() - enqueuedAt));
    });
  }

  /**
   * Stop the interval timer.  Must be called after use to allow the event loop
   * to exit cleanly (especially important in tests).
   */
  destroy(): void {
    clearInterval(this.intervalHandle);
  }
}
