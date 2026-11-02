/**
 * One GPU serves students' answers and background enrichment. Background work
 * waits while any answer is being produced, so students never queue behind it.
 */
let active = 0;
let waiters: (() => void)[] = [];

/** Marks an answer as running; call the returned function when it is done (safe to call twice). */
export function startForegroundWork(): () => void {
  active++;
  let finished = false;

  return () => {
    if (finished) return;
    finished = true;
    active--;

    if (active === 0) {
      const ready = waiters;
      waiters = [];
      ready.forEach((resolve) => resolve());
    }
  };
}

/** Resolves when no answer is running. */
export function foregroundIdle(): Promise<void> {
  return active === 0 ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve));
}
