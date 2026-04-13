function getStoreStub(env) {
  if (!env?.ACCOUNT_STORE) {
    throw new Error('未配置 ACCOUNT_STORE Durable Object 绑定');
  }
  const id = env.ACCOUNT_STORE.idFromName('global');
  return env.ACCOUNT_STORE.get(id);
}

async function callStore(env, path, payload = {}) {
  const stub = getStoreStub(env);
  const response = await stub.fetch(`https://account-store${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || '账户存储服务异常');
  }
  return data;
}

export async function registerUser(env, payload) {
  const data = await callStore(env, '/register', payload);
  return data.user;
}

export async function loginUser(env, payload) {
  const data = await callStore(env, '/login', payload);
  return data.user;
}

export async function getUserById(env, userId) {
  const data = await callStore(env, '/user-by-id', { userId });
  return data.user || null;
}

export async function redeemCoupon(env, payload) {
  return callStore(env, '/redeem', payload);
}

export async function consumePoint(env, payload) {
  const data = await callStore(env, '/consume', payload);
  return data.user;
}

export async function refundPoint(env, payload) {
  const data = await callStore(env, '/refund', payload);
  return data.user || null;
}

export async function generateCoupons(env, payload) {
  const data = await callStore(env, '/generate-coupons', payload);
  return data.coupons || [];
}

export async function listCoupons(env, payload = {}) {
  const data = await callStore(env, '/list-coupons', payload);
  return data.coupons || [];
}

export async function getAdminStats(env) {
  const data = await callStore(env, '/admin-stats', {});
  return data.stats || {};
}

