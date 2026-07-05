// Make a flaky upstream invisible. Anthropic's API has transient 500s (and the occasional
// overload / network blip); without retries a single one drops a Director turn — Mara goes
// silent — or kills a build he just approved. This wraps a unit of work so a TRANSIENT failure
// re-runs with backoff, while a real error (or exhausted attempts) still surfaces honestly.
//
// Two layers use it: the Anthropic client retries individual API calls (SDK maxRetries), and a
// whole BUILD is wrapped here too — because a build's worker is a separate `claude` CLI process,
// not our SDK, so the SDK's retries can't cover it; re-running the build is the only lever.

// Is this error worth retrying? 5xx / overloaded / rate-limit / network resets — yes. A 4xx
// (bad request, auth) or a plain bug — no, retrying just wastes time and money.
export function isTransient(err) {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (typeof status === 'number') {
    if (status >= 500) return true;
    if (status === 429 || status === 408 || status === 409) return true;
    if (status >= 400) return false; // other 4xx: not our friend, don't retry
  }
  return /(\b5\d\d\b|\b429\b|\b408\b|internal server error|overloaded|api_error|econnreset|etimedout|socket hang up|network|fetch failed)/i.test(
    String(err?.message ?? err),
  );
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run fn(); on a transient failure, wait (linear backoff) and try again, up to `attempts`.
// Re-throws the last error if attempts run out or the error isn't transient.
export async function withRetry(fn, { attempts = 3, baseMs = 1500, sleep = defaultSleep, onRetry = () => {} } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (i >= attempts || !isTransient(err)) throw err;
      onRetry(i, err);
      await sleep(baseMs * i);
    }
  }
  throw lastErr;
}
