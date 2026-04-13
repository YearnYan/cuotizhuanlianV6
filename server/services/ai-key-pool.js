const { AI_CONFIG } = require('../config/ai');

const BASE_COOLDOWN_MS = toInt(process.env.AI_KEY_BASE_COOLDOWN_MS, 8000);
const MAX_COOLDOWN_MS = toInt(process.env.AI_KEY_MAX_COOLDOWN_MS, 120000);

const keyStates = (AI_CONFIG.apiKeys || []).map((key, index) => ({
  key,
  index,
  inFlight: 0,
  failCount: 0,
  cooldownUntil: 0,
  totalCalls: 0,
  totalErrors: 0
}));

let tieBreaker = 0;

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function classifyError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 502 || status === 503 || status === 504) return 'temporary';
  return 'other';
}

function pickBestState() {
  if (keyStates.length === 0) {
    throw new Error('未配置可用的 AI API Key');
  }
  const now = Date.now();
  const available = keyStates.filter((state) => state.cooldownUntil <= now);
  const candidates = available.length > 0 ? available : keyStates;

  let best = null;
  for (const state of candidates) {
    const failWeight = state.failCount * 0.2;
    const score = state.inFlight + failWeight;
    if (!best || score < best.score) {
      best = { state, score };
      continue;
    }
    if (score === best.score) {
      const modA = (state.index + tieBreaker) % keyStates.length;
      const modB = (best.state.index + tieBreaker) % keyStates.length;
      if (modA < modB) {
        best = { state, score };
      }
    }
  }
  tieBreaker = (tieBreaker + 1) % Math.max(1, keyStates.length);
  return best.state;
}

function acquireAIKeyLease() {
  const state = pickBestState();
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

function getAIKeyPoolSnapshot() {
  const now = Date.now();
  return keyStates.map((state) => ({
    index: state.index,
    inFlight: state.inFlight,
    failCount: state.failCount,
    totalCalls: state.totalCalls,
    totalErrors: state.totalErrors,
    cooling: state.cooldownUntil > now,
    cooldownMsLeft: Math.max(0, state.cooldownUntil - now)
  }));
}

module.exports = {
  acquireAIKeyLease,
  getAIKeyPoolSnapshot
};

