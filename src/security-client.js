// 前端安全请求封装：用于请求令牌与自动重试
(function initSecurityClient(global) {
  const API_BASE = '/api';
  const BOOTSTRAP_URL = `${API_BASE}/security/bootstrap`;

  const state = {
    requestToken: '',
    expiresAt: 0,
    bootstrapPromise: null
  };

  function createRequestId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function hasValidToken() {
    if (!state.requestToken) return false;
    return Date.now() < (state.expiresAt - 5000);
  }

  async function ensureRequestToken(forceRefresh = false) {
    if (!forceRefresh && hasValidToken()) {
      return state.requestToken;
    }

    if (state.bootstrapPromise) {
      return state.bootstrapPromise;
    }

    state.bootstrapPromise = (async () => {
      const resp = await global.fetch(BOOTSTRAP_URL, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          'X-CX-Request-Id': createRequestId()
        }
      });

      if (!resp.ok) {
        throw new Error('安全令牌初始化失败');
      }

      const data = await resp.json();
      state.requestToken = data.requestToken || '';
      state.expiresAt = Number(data.expiresAt) || 0;
      return state.requestToken;
    })();

    try {
      return await state.bootstrapPromise;
    } finally {
      state.bootstrapPromise = null;
    }
  }

  async function apiFetch(url, options = {}, retry = true) {
    const isProtectedApi = typeof url === 'string'
      && url.startsWith(API_BASE)
      && !url.startsWith(BOOTSTRAP_URL);

    const headers = {
      ...(options.headers || {}),
      'X-CX-Request-Id': createRequestId()
    };

    if (isProtectedApi) {
      const token = await ensureRequestToken();
      if (token) {
        headers['X-CX-Request-Token'] = token;
      }
    }

    let resp = await global.fetch(url, {
      ...options,
      credentials: 'same-origin',
      headers
    });

    if (
      retry
      && isProtectedApi
      && resp.status === 403
      && resp.headers.get('x-cx-token-invalid') === '1'
    ) {
      await ensureRequestToken(true);
      const retryHeaders = {
        ...(options.headers || {}),
        'X-CX-Request-Id': createRequestId()
      };
      if (state.requestToken) {
        retryHeaders['X-CX-Request-Token'] = state.requestToken;
      }
      resp = await global.fetch(url, {
        ...options,
        credentials: 'same-origin',
        headers: retryHeaders
      });
    }

    return resp;
  }

  global.apiFetch = apiFetch;
  global.ensureRequestToken = ensureRequestToken;
})(window);
