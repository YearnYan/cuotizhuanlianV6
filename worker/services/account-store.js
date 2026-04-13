const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 64;
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 24;

// Cloudflare Workers WebCrypto 当前对 PBKDF2 迭代次数有上限限制（<=100000）
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_HASH_LENGTH = 32;
const PBKDF2_DIGEST = 'SHA-256';

const state = {
  nextUserId: 1,
  nextCouponId: 1,
  users: [],
  coupons: [],
  pointLogs: []
};

let mutationQueue = Promise.resolve();

function runMutation(mutator) {
  const task = mutationQueue
    .catch(() => {})
    .then(async () => mutator(state));

  mutationQueue = task.catch(() => {});
  return task;
}

function nowIso() {
  return new Date().toISOString();
}

function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (v) => v.toString(16).padStart(2, '0')).join('');
}

function normalizeUsername(username) {
  return String(username || '').trim();
}

function validateUsername(username) {
  const normalized = normalizeUsername(username);
  if (!normalized) throw new Error('用户名不能为空');
  if (normalized.length < MIN_USERNAME_LENGTH || normalized.length > MAX_USERNAME_LENGTH) {
    throw new Error(`用户名长度需在 ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} 个字符之间`);
  }
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5]+$/.test(normalized)) {
    throw new Error('用户名仅支持中文、字母、数字、下划线');
  }
  return normalized;
}

function validatePassword(password) {
  const normalized = String(password || '');
  if (normalized.length < MIN_PASSWORD_LENGTH || normalized.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`密码长度需在 ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 个字符之间`);
  }
  return normalized;
}

function normalizeCouponCode(code) {
  return String(code || '').trim().toUpperCase();
}

function createCouponCode() {
  return `CP${randomHex(6).toUpperCase()}`;
}

async function hashPassword(password, saltHex) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const saltBytes = new Uint8Array(saltHex.match(/.{1,2}/g).map((hex) => parseInt(hex, 16)));
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: PBKDF2_DIGEST,
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS
    },
    keyMaterial,
    PBKDF2_HASH_LENGTH * 8
  );
  const bytes = new Uint8Array(bits);
  return Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');
}

async function createPasswordHash(password) {
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  return { salt, hash };
}

function safeEqualHex(aHex, bHex) {
  if (!aHex || !bHex || aHex.length !== bHex.length) return false;
  let diff = 0;
  for (let i = 0; i < aHex.length; i += 1) {
    diff |= aHex.charCodeAt(i) ^ bHex.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyPassword(password, salt, hash) {
  const actual = await hashPassword(password, salt);
  return safeEqualHex(actual, String(hash || ''));
}

function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    points: Number(user.points || 0),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || ''
  };
}

function sanitizeCoupon(coupon) {
  return {
    id: coupon.id,
    code: coupon.code,
    points: Number(coupon.points || 0),
    status: coupon.status,
    createdAt: coupon.createdAt,
    createdBy: coupon.createdBy || '',
    redeemedAt: coupon.redeemedAt || '',
    redeemedBy: coupon.redeemedBy || ''
  };
}

function appendPointLog(store, log) {
  store.pointLogs.push({
    id: `${Date.now()}-${randomHex(4)}`,
    ...log
  });
  if (store.pointLogs.length > 5000) {
    store.pointLogs = store.pointLogs.slice(store.pointLogs.length - 5000);
  }
}

export async function registerUser({ username, password }) {
  return runMutation(async (store) => {
    const finalUsername = validateUsername(username);
    const finalPassword = validatePassword(password);
    const usernameLower = finalUsername.toLowerCase();
    const exists = store.users.some(
      (user) => String(user.username || '').toLowerCase() === usernameLower
    );
    if (exists) throw new Error('用户名已存在');

    const { salt, hash } = await createPasswordHash(finalPassword);
    const now = nowIso();
    const user = {
      id: store.nextUserId,
      username: finalUsername,
      passwordSalt: salt,
      passwordHash: hash,
      points: 0,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: ''
    };
    store.nextUserId += 1;
    store.users.push(user);
    return sanitizeUser(user);
  });
}

export async function loginUser({ username, password }) {
  return runMutation(async (store) => {
    const finalUsername = validateUsername(username);
    const finalPassword = validatePassword(password);
    const user = store.users.find(
      (item) => String(item.username || '').toLowerCase() === finalUsername.toLowerCase()
    );
    if (!user) throw new Error('用户名或密码错误');

    const ok = await verifyPassword(finalPassword, user.passwordSalt, user.passwordHash);
    if (!ok) throw new Error('用户名或密码错误');

    user.lastLoginAt = nowIso();
    user.updatedAt = user.lastLoginAt;
    return sanitizeUser(user);
  });
}

export async function getUserById(userId) {
  const user = state.users.find((item) => Number(item.id) === Number(userId));
  return user ? sanitizeUser(user) : null;
}

export async function redeemCoupon({ userId, code }) {
  return runMutation(async (store) => {
    const user = store.users.find((item) => Number(item.id) === Number(userId));
    if (!user) throw new Error('用户不存在');

    const normalized = normalizeCouponCode(code);
    if (!normalized) throw new Error('兑换码不能为空');

    const coupon = store.coupons.find(
      (item) => String(item.code || '').toUpperCase() === normalized
    );
    if (!coupon) throw new Error('兑换码不存在');
    if (coupon.status === 'used') throw new Error('兑换码已被使用');

    coupon.status = 'used';
    coupon.redeemedBy = user.username;
    coupon.redeemedByUserId = user.id;
    coupon.redeemedAt = nowIso();

    user.points = Number(user.points || 0) + Number(coupon.points || 0);
    user.updatedAt = nowIso();

    appendPointLog(store, {
      userId: user.id,
      username: user.username,
      delta: Number(coupon.points || 0),
      reason: 'coupon_redeem',
      metadata: { code: coupon.code }
    });

    return {
      user: sanitizeUser(user),
      coupon: sanitizeCoupon(coupon)
    };
  });
}

export async function consumePoint({ userId, amount = 1, reason = 'usage', metadata = {} }) {
  return runMutation(async (store) => {
    const user = store.users.find((item) => Number(item.id) === Number(userId));
    if (!user) throw new Error('用户不存在');

    const cost = Math.max(1, Number.parseInt(amount, 10) || 1);
    const current = Number(user.points || 0);
    if (current < cost) {
      throw new Error('积分不足，请先兑换积分');
    }

    user.points = current - cost;
    user.updatedAt = nowIso();

    appendPointLog(store, {
      userId: user.id,
      username: user.username,
      delta: -cost,
      reason,
      metadata
    });

    return sanitizeUser(user);
  });
}

export async function refundPoint({ userId, amount = 1, reason = 'refund', metadata = {} }) {
  return runMutation(async (store) => {
    const user = store.users.find((item) => Number(item.id) === Number(userId));
    if (!user) return null;
    const delta = Math.max(1, Number.parseInt(amount, 10) || 1);

    user.points = Number(user.points || 0) + delta;
    user.updatedAt = nowIso();
    appendPointLog(store, {
      userId: user.id,
      username: user.username,
      delta,
      reason,
      metadata
    });
    return sanitizeUser(user);
  });
}

export async function generateCoupons({ points, quantity, createdBy = 'admin' }) {
  return runMutation(async (store) => {
    const pointValue = Number.parseInt(points, 10);
    const count = Number.parseInt(quantity, 10);
    if (!Number.isFinite(pointValue) || pointValue <= 0) {
      throw new Error('积分额度必须为正整数');
    }
    if (!Number.isFinite(count) || count <= 0 || count > 500) {
      throw new Error('生成数量需在 1~500 之间');
    }

    const existingCodes = new Set(store.coupons.map((item) => String(item.code || '').toUpperCase()));
    const created = [];

    for (let i = 0; i < count; i += 1) {
      let code = createCouponCode();
      while (existingCodes.has(code)) {
        code = createCouponCode();
      }
      existingCodes.add(code);

      const coupon = {
        id: store.nextCouponId,
        code,
        points: pointValue,
        status: 'unused',
        createdBy,
        createdAt: nowIso(),
        redeemedBy: '',
        redeemedByUserId: null,
        redeemedAt: ''
      };
      store.nextCouponId += 1;
      store.coupons.push(coupon);
      created.push(sanitizeCoupon(coupon));
    }

    return created;
  });
}

export async function listCoupons({ limit = 200 } = {}) {
  const safeLimit = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || 200));
  return state.coupons
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, safeLimit)
    .map(sanitizeCoupon);
}

export async function getAdminStats() {
  const totalUsers = state.users.length;
  const totalCoupons = state.coupons.length;
  const usedCoupons = state.coupons.filter((item) => item.status === 'used').length;
  const totalIssuedPoints = state.coupons.reduce((sum, item) => sum + Number(item.points || 0), 0);
  const totalRemainingPoints = state.users.reduce((sum, item) => sum + Number(item.points || 0), 0);
  return {
    totalUsers,
    totalCoupons,
    usedCoupons,
    unusedCoupons: Math.max(0, totalCoupons - usedCoupons),
    totalIssuedPoints,
    totalRemainingPoints
  };
}
