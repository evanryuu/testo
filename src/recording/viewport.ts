export type ViewportSize = { width: number; height: number };

export function waitForStableViewport(
  readSize: () => Promise<ViewportSize>,
  options: {
    expected?: ViewportSize;
    signal?: AbortSignal;
    timeoutMs?: number;
    stableForMs?: number;
    pollMs?: number;
  } = {},
): Promise<ViewportSize> {
  const { expected, signal, timeoutMs = 5000, stableForMs = 500, pollMs = 100 } = options;
  const valid = (size: ViewportSize) => Number.isFinite(size?.width) && size.width > 0 && Number.isFinite(size?.height) && size.height > 0;
  const equal = (a: ViewportSize, b: ViewportSize) => a.width === b.width && a.height === b.height;
  if (![timeoutMs, pollMs].every(value => Number.isFinite(value) && value > 0) || !Number.isFinite(stableForMs) || stableForMs < 0 || (expected && !valid(expected))) {
    return Promise.reject(new Error('视口稳定检测参数无效'));
  }
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('视口检测已取消'));

  return new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let previous: ViewportSize | undefined;
    let lastSize: ViewportSize | undefined;
    let stableSince = 0;
    const finish = (error?: unknown, size?: ViewportSize) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(pollTimer);
      signal?.removeEventListener('abort', onAbort);
      if (size) resolve(size);
      else reject(error);
    };
    const onAbort = () => finish(signal?.reason ?? new Error('视口检测已取消'));
    const deadlineTimer = setTimeout(() => {
      const dimensions = (size: ViewportSize) => `${size.width} × ${size.height}`;
      finish(new Error(`视口未能稳定：预期 ${expected ? dimensions(expected) : '稳定的有效尺寸'}，实际 ${lastSize ? dimensions(lastSize) : '未获取'}，等待上限 ${timeoutMs}ms`));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    const poll = async () => {
      if (settled) return;
      try {
        const size = await readSize();
        if (settled) return;
        if (valid(size)) {
          lastSize = { width: size.width, height: size.height };
          const now = performance.now();
          if (!previous || !equal(size, previous)) stableSince = now;
          previous = lastSize;
          if ((!expected || equal(size, expected)) && now - stableSince >= stableForMs) {
            finish(undefined, lastSize);
            return;
          }
        } else previous = undefined;
      } catch {
        // Navigation can briefly replace the execution context; require stability again.
        previous = undefined;
      }
      if (!settled) pollTimer = setTimeout(poll, pollMs);
    };
    void poll();
  });
}
