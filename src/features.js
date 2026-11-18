// features.js — same-origin, fail-closed runtime feature flags.
const FEATURES_URL = './config/features.json';
const FEATURE_TIMEOUT_MS = 4000;
const DISABLED_FEATURES = Object.freeze({ supportCreator: false });

/**
 * Load validated runtime features from WaveSync's fixed same-origin config path.
 * Any unavailable, non-OK, malformed, missing, or non-boolean value fails closed.
 *
 * @param {typeof globalThis.fetch} fetcher injectable fetch implementation for tests
 * @param {{timeoutMs?: number}} options optional bounded timeout override
 * @returns {Promise<{supportCreator: boolean}>}
 */
export async function loadFeatures(fetcher = globalThis.fetch, options = {}) {
  if (typeof fetcher !== 'function') return { ...DISABLED_FEATURES };

  const configuredTimeout = options && typeof options === 'object' ? options.timeoutMs : undefined;
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(configuredTimeout, FEATURE_TIMEOUT_MS)
    : FEATURE_TIMEOUT_MS;
  const controller = new AbortController();
  let timeout;
  const timedOut = new Promise((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({ ...DISABLED_FEATURES });
    }, timeoutMs);
  });
  const request = (async () => {
    const response = await fetcher(FEATURES_URL, {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response?.ok || typeof response.json !== 'function') return { ...DISABLED_FEATURES };
    const config = await response.json();
    return { supportCreator: config?.supportCreator === true };
  })();

  try {
    return await Promise.race([request, timedOut]);
  } catch {
    return { ...DISABLED_FEATURES };
  } finally {
    clearTimeout(timeout);
  }
}
