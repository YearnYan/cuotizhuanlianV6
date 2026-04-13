const BASE_COOLDOWN_MS = 8000;
const MAX_COOLDOWN_MS = 120000;

const poolBySignature = new Map();

function parseApiKeys(env) {
  const fromList = String(env?.AI_API_KEYS || '')
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const single = String(env?.AI_API_KEY || '').trim();
  return Array.from(new Set([...fromList, single].filter(Boolean)));
}

function classifyError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 502 || status === 503 || status === 504) return 'temporary';
  return 'other';
}

function getPool(env) {
  const keys = parseApiKeys(env);
  const signature = keys.join('|');
  if (!signature) {
    throw new Error('未配置可用的 AI API Key');
  }

  if (!poolBySignature.has(signature)) {
    poolBySignature.set(signature, {
      tieBreaker: 0,
      states: keys.map((key, index) => ({
        key,
        index,
        inFlight: 0,
        failCount: 0,
        cooldownUntil: 0,
        totalCalls: 0,
        totalErrors: 0
      }))
    });
  }

  return poolBySignature.get(signature);
}

function pickBestState(pool) {
  const now = Date.now();
  const available = pool.states.filter((item) => item.cooldownUntil <= now);
  const candidates = available.length ? available : pool.states;

  let best = null;
  for (const state of candidates) {
    const failWeight = state.failCount * 0.2;
    const score = state.inFlight + failWeight;
    if (!best || score < best.score) {
      best = { state, score };
      continue;
    }

    if (score === best.score) {
      const modA = (state.index + pool.tieBreaker) % pool.states.length;
      const modB = (best.state.index + pool.tieBreaker) % pool.states.length;
      if (modA < modB) {
        best = { state, score };
      }
    }
  }

  pool.tieBreaker = (pool.tieBreaker + 1) % Math.max(1, pool.states.length);
  return best.state;
}

export function acquireAIKeyLease(env) {
  const pool = getPool(env);
  const state = pickBestState(pool);
  state.inFlight += 1;
  state.totalCalls += 1;
  const startedAt = Date.now();

  return {
    apiKey: state.key,
    index: state.index,
    release(success, error = null) {
      state.inFlight = Math.max(0, state.inFlight - 1);
      if (success) {
        state.failCount = Math.max(0, state.failCount - 1);
        return;
      }

      state.totalErrors += 1;
      const errorType = classifyError(error);
      const now = Date.now();
      if (errorType === 'auth') {
        state.failCount = Math.min(100, state.failCount + 5);
        state.cooldownUntil = Math.max(state.cooldownUntil, now + MAX_COOLDOWN_MS);
        return;
      }

      const attemptMs = Math.max(1, now - startedAt);
      const penalty = Math.min(
        MAX_COOLDOWN_MS,
        BASE_COOLDOWN_MS + state.failCount * 1500 + Math.min(5000, attemptMs)
      );
      state.failCount = Math.min(100, state.failCount + 1);
      state.cooldownUntil = Math.max(state.cooldownUntil, now + penalty);
    }
  };
}

export function getAIKeyPoolSnapshot(env) {
  const pool = getPool(env);
  const now = Date.now();
  return pool.states.map((state) => ({
    index: state.index,
    inFlight: state.inFlight,
    failCount: state.failCount,
    totalCalls: state.totalCalls,
    totalErrors: state.totalErrors,
    cooling: state.cooldownUntil > now,
    cooldownMsLeft: Math.max(0, state.cooldownUntil - now)
  }));
}

