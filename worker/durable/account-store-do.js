const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 64;

const PBKDF2_ITERATIONS = 100000;
const PBKDF2_HASH_LENGTH = 32;
const PBKDF2_DIGEST = 'SHA-256';

const STORAGE_KEY = 'account_data_v1';

function createError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function buildDefaultData() {
  return {
    nextUserId: 1,
    nextCouponId: 1,
    users: [],
    coupons: [],
    pointLogs: []
  };
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
  if (!normalized) throw createError('用户名不能为空');
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5]+$/.test(normalized)) {
    throw createError('用户名仅支持中文、字母、数字、下划线');
  }
  return normalized;
}

function validatePassword(password) {
  const normalized = String(password || '');
  if (normalized.length < MIN_PASSWORD_LENGTH || normalized.length > MAX_PASSWORD_LENGTH) {
    throw createError(`密码长度需在 ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 个字符之间`);
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

function appendPointLog(data, log) {
  data.pointLogs.push({
    id: `${Date.now()}-${randomHex(4)}`,
    ...log
  });
  if (data.pointLogs.length > 5000) {
    data.pointLogs = data.pointLogs.slice(data.pointLogs.length - 5000);
  }
}

function normalizeData(raw) {
  const base = buildDefaultData();
  const parsed = raw && typeof raw === 'object' ? raw : {};
  return {
    ...base,
    ...parsed,
    users: Array.isArray(parsed.users) ? parsed.users : [],
    coupons: Array.isArray(parsed.coupons) ? parsed.coupons : [],
    pointLogs: Array.isArray(parsed.pointLogs) ? parsed.pointLogs : []
  };
}

export class AccountStoreDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async loadData() {
    const raw = await this.state.storage.get(STORAGE_KEY);
    if (!raw) {
      const initial = buildDefaultData();
      await this.state.storage.put(STORAGE_KEY, initial);
      return initial;
    }
    return normalizeData(raw);
  }

  async saveData(data) {
    await this.state.storage.put(STORAGE_KEY, data);
  }

  async withData(mutator, write = true) {
    const data = await this.loadData();
    const result = await mutator(data);
    if (write) {
      await this.saveData(data);
    }
    return result;
  }

  async handleRegister(body) {
    return this.withData(async (data) => {
      const finalUsername = validateUsername(body?.username);
      const finalPassword = validatePassword(body?.password);
      const usernameLower = finalUsername.toLowerCase();
      const exists = data.users.some((user) => String(user.username || '').toLowerCase() === usernameLower);
      if (exists) throw createError('用户名已存在');

      const { salt, hash } = await createPasswordHash(finalPassword);
      const now = nowIso();
      const user = {
        id: data.nextUserId,
        username: finalUsername,
        passwordSalt: salt,
        passwordHash: hash,
        points: 0,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: ''
      };
      data.nextUserId += 1;
      data.users.push(user);
      return { user: sanitizeUser(user) };
    });
  }

  async handleLogin(body) {
    return this.withData(async (data) => {
      const finalUsername = validateUsername(body?.username);
      const finalPassword = validatePassword(body?.password);
      const user = data.users.find((item) => String(item.username || '').toLowerCase() === finalUsername.toLowerCase());
      if (!user) throw createError('用户名或密码错误');

      const ok = await verifyPassword(finalPassword, user.passwordSalt, user.passwordHash);
      if (!ok) throw createError('用户名或密码错误');

      user.lastLoginAt = nowIso();
      user.updatedAt = user.lastLoginAt;
      return { user: sanitizeUser(user) };
    });
  }

  async handleGetUserById(body) {
    return this.withData(async (data) => {
      const userId = Number(body?.userId || 0);
      const user = data.users.find((item) => Number(item.id) === userId);
      return { user: user ? sanitizeUser(user) : null };
    }, false);
  }

  async handleRedeem(body) {
    return this.withData(async (data) => {
      const userId = Number(body?.userId || 0);
      const user = data.users.find((item) => Number(item.id) === userId);
      if (!user) throw createError('用户不存在');

      const code = normalizeCouponCode(body?.code);
      if (!code) throw createError('兑换码不能为空');

      const coupon = data.coupons.find((item) => String(item.code || '').toUpperCase() === code);
      if (!coupon) throw createError('兑换码不存在');
      if (coupon.status === 'used') throw createError('兑换码已被使用');

      coupon.status = 'used';
      coupon.redeemedBy = user.username;
      coupon.redeemedByUserId = user.id;
      coupon.redeemedAt = nowIso();

      user.points = Number(user.points || 0) + Number(coupon.points || 0);
      user.updatedAt = nowIso();

      appendPointLog(data, {
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

  async handleConsume(body) {
    return this.withData(async (data) => {
      const userId = Number(body?.userId || 0);
      const user = data.users.find((item) => Number(item.id) === userId);
      if (!user) throw createError('用户不存在');

      const cost = Math.max(1, Number.parseInt(body?.amount, 10) || 1);
      const current = Number(user.points || 0);
      if (current < cost) throw createError('积分不足，请先兑换积分');

      user.points = current - cost;
      user.updatedAt = nowIso();
      appendPointLog(data, {
        userId: user.id,
        username: user.username,
        delta: -cost,
        reason: String(body?.reason || 'usage'),
        metadata: body?.metadata || {}
      });
      return { user: sanitizeUser(user) };
    });
  }

  async handleRefund(body) {
    return this.withData(async (data) => {
      const userId = Number(body?.userId || 0);
      const user = data.users.find((item) => Number(item.id) === userId);
      if (!user) return { user: null };

      const delta = Math.max(1, Number.parseInt(body?.amount, 10) || 1);
      user.points = Number(user.points || 0) + delta;
      user.updatedAt = nowIso();
      appendPointLog(data, {
        userId: user.id,
        username: user.username,
        delta,
        reason: String(body?.reason || 'refund'),
        metadata: body?.metadata || {}
      });
      return { user: sanitizeUser(user) };
    });
  }

  async handleGenerateCoupons(body) {
    return this.withData(async (data) => {
      const pointValue = Number.parseInt(body?.points, 10);
      const count = Number.parseInt(body?.quantity, 10);
      if (!Number.isFinite(pointValue) || pointValue <= 0) {
        throw createError('积分额度必须为正整数');
      }
      if (!Number.isFinite(count) || count <= 0 || count > 500) {
        throw createError('生成数量需在 1~500 之间');
      }

      const existing = new Set(data.coupons.map((item) => String(item.code || '').toUpperCase()));
      const created = [];
      for (let i = 0; i < count; i += 1) {
        let code = createCouponCode();
        while (existing.has(code)) {
          code = createCouponCode();
        }
        existing.add(code);

        const coupon = {
          id: data.nextCouponId,
          code,
          points: pointValue,
          status: 'unused',
          createdBy: String(body?.createdBy || 'admin'),
          createdAt: nowIso(),
          redeemedBy: '',
          redeemedByUserId: null,
          redeemedAt: ''
        };
        data.nextCouponId += 1;
        data.coupons.push(coupon);
        created.push(sanitizeCoupon(coupon));
      }

      return { coupons: created };
    });
  }

  async handleListCoupons(body) {
    return this.withData(async (data) => {
      const limit = Math.max(1, Math.min(1000, Number.parseInt(body?.limit, 10) || 200));
      const coupons = data.coupons
        .slice()
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        .slice(0, limit)
        .map(sanitizeCoupon);
      return { coupons };
    }, false);
  }

  async handleAdminStats() {
    return this.withData(async (data) => {
      const totalUsers = data.users.length;
      const totalCoupons = data.coupons.length;
      const usedCoupons = data.coupons.filter((item) => item.status === 'used').length;
      const totalIssuedPoints = data.coupons.reduce((sum, item) => sum + Number(item.points || 0), 0);
      const totalRemainingPoints = data.users.reduce((sum, item) => sum + Number(item.points || 0), 0);
      return {
        stats: {
          totalUsers,
          totalCoupons,
          usedCoupons,
          unusedCoupons: Math.max(0, totalCoupons - usedCoupons),
          totalIssuedPoints,
          totalRemainingPoints
        }
      };
    }, false);
  }

  async fetch(request) {
    try {
      if (request.method !== 'POST') {
        throw createError('Method Not Allowed', 405);
      }
      const url = new URL(request.url);
      const body = await request.json().catch(() => ({}));

      switch (url.pathname) {
        case '/register': return json(await this.handleRegister(body));
        case '/login': return json(await this.handleLogin(body));
        case '/user-by-id': return json(await this.handleGetUserById(body));
        case '/redeem': return json(await this.handleRedeem(body));
        case '/consume': return json(await this.handleConsume(body));
        case '/refund': return json(await this.handleRefund(body));
        case '/generate-coupons': return json(await this.handleGenerateCoupons(body));
        case '/list-coupons': return json(await this.handleListCoupons(body));
        case '/admin-stats': return json(await this.handleAdminStats());
        default: return json({ error: 'Not Found' }, 404);
      }
    } catch (error) {
      const status = Number(error?.status || 400);
      return json({ error: error.message || '操作失败' }, status);
    }
  }
}
