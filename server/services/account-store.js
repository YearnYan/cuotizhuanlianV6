const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'account-data.json');
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 64;
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 24;

const PBKDF2_ITERATIONS = 120000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';

let mutationQueue = Promise.resolve();

function buildDefaultData() {
  return {
    nextUserId: 1,
    nextCouponId: 1,
    users: [],
    coupons: [],
    pointLogs: []
  };
}

async function ensureDataFile() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.promises.access(DATA_FILE, fs.constants.F_OK);
  } catch {
    const content = JSON.stringify(buildDefaultData(), null, 2);
    await fs.promises.writeFile(DATA_FILE, content, 'utf8');
  }
}

async function readData() {
  await ensureDataFile();
  const raw = await fs.promises.readFile(DATA_FILE, 'utf8');
  const parsed = JSON.parse(raw || '{}');
  return {
    ...buildDefaultData(),
    ...parsed,
    users: Array.isArray(parsed.users) ? parsed.users : [],
    coupons: Array.isArray(parsed.coupons) ? parsed.coupons : [],
    pointLogs: Array.isArray(parsed.pointLogs) ? parsed.pointLogs : []
  };
}

async function writeData(data) {
  const content = JSON.stringify(data, null, 2);
  await fs.promises.writeFile(DATA_FILE, content, 'utf8');
}

function runMutation(mutator) {
  mutationQueue = mutationQueue.then(async () => {
    const data = await readData();
    const result = await mutator(data);
    await writeData(data);
    return result;
  });
  return mutationQueue;
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

function hashPassword(password, salt) {
  return crypto
    .pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST)
    .toString('hex');
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const expected = hashPassword(password, salt);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(hash || ''), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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

function normalizeCouponCode(code) {
  return String(code || '').trim().toUpperCase();
}

function createCouponCode() {
  return `CP${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

function sanitizeCoupon(coupon) {
  return {
    id: coupon.id,
    code: coupon.code,
    points: coupon.points,
    status: coupon.status,
    createdAt: coupon.createdAt,
    createdBy: coupon.createdBy || '',
    redeemedAt: coupon.redeemedAt || '',
    redeemedBy: coupon.redeemedBy || ''
  };
}

function appendPointLog(data, log) {
  data.pointLogs.push({
    id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    ...log
  });
  if (data.pointLogs.length > 5000) {
    data.pointLogs = data.pointLogs.slice(data.pointLogs.length - 5000);
  }
}

async function registerUser({ username, password }) {
  return runMutation(async (data) => {
    const finalUsername = validateUsername(username);
    const finalPassword = validatePassword(password);
    const usernameLower = finalUsername.toLowerCase();
    const exists = data.users.some((user) => String(user.username || '').toLowerCase() === usernameLower);
    if (exists) throw new Error('用户名已存在');

    const { salt, hash } = createPasswordHash(finalPassword);
    const now = new Date().toISOString();
    const user = {
      id: data.nextUserId++,
      username: finalUsername,
      passwordSalt: salt,
      passwordHash: hash,
      points: 0,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: ''
    };
    data.users.push(user);
    return sanitizeUser(user);
  });
}

async function loginUser({ username, password }) {
  return runMutation(async (data) => {
    const finalUsername = validateUsername(username);
    const finalPassword = validatePassword(password);
    const user = data.users.find((item) => String(item.username || '').toLowerCase() === finalUsername.toLowerCase());
    if (!user) throw new Error('用户名或密码错误');
    if (!verifyPassword(finalPassword, user.passwordSalt, user.passwordHash)) {
      throw new Error('用户名或密码错误');
    }

    user.lastLoginAt = new Date().toISOString();
    user.updatedAt = user.lastLoginAt;
    return sanitizeUser(user);
  });
}

async function getUserById(userId) {
  const data = await readData();
  const user = data.users.find((item) => Number(item.id) === Number(userId));
  return user ? sanitizeUser(user) : null;
}

async function redeemCoupon({ userId, code }) {
  return runMutation(async (data) => {
    const user = data.users.find((item) => Number(item.id) === Number(userId));
    if (!user) throw new Error('用户不存在');

    const normalized = normalizeCouponCode(code);
    if (!normalized) throw new Error('兑换码不能为空');

    const coupon = data.coupons.find((item) => String(item.code || '').toUpperCase() === normalized);
    if (!coupon) throw new Error('兑换码不存在');
    if (coupon.status === 'used') throw new Error('兑换码已被使用');

    coupon.status = 'used';
    coupon.redeemedBy = user.username;
    coupon.redeemedByUserId = user.id;
    coupon.redeemedAt = new Date().toISOString();

    user.points = Number(user.points || 0) + Number(coupon.points || 0);
    user.updatedAt = new Date().toISOString();

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

async function consumePoint({ userId, amount = 1, reason = 'usage', metadata = {} }) {
  return runMutation(async (data) => {
    const user = data.users.find((item) => Number(item.id) === Number(userId));
    if (!user) throw new Error('用户不存在');

    const cost = Math.max(1, Number.parseInt(amount, 10) || 1);
    const currentPoints = Number(user.points || 0);
    if (currentPoints < cost) {
      throw new Error('积分不足，请先兑换积分');
    }

    user.points = currentPoints - cost;
    user.updatedAt = new Date().toISOString();
    appendPointLog(data, {
      userId: user.id,
      username: user.username,
      delta: -cost,
      reason,
      metadata
    });
    return sanitizeUser(user);
  });
}

async function refundPoint({ userId, amount = 1, reason = 'refund', metadata = {} }) {
  return runMutation(async (data) => {
    const user = data.users.find((item) => Number(item.id) === Number(userId));
    if (!user) return null;
    const delta = Math.max(1, Number.parseInt(amount, 10) || 1);
    user.points = Number(user.points || 0) + delta;
    user.updatedAt = new Date().toISOString();
    appendPointLog(data, {
      userId: user.id,
      username: user.username,
      delta,
      reason,
      metadata
    });
    return sanitizeUser(user);
  });
}

async function generateCoupons({ points, quantity, createdBy = 'admin' }) {
  return runMutation(async (data) => {
    const pointValue = Number.parseInt(points, 10);
    const count = Number.parseInt(quantity, 10);
    if (!Number.isFinite(pointValue) || pointValue <= 0) {
      throw new Error('积分额度必须为正整数');
    }
    if (!Number.isFinite(count) || count <= 0 || count > 500) {
      throw new Error('生成数量需在 1~500 之间');
    }

    const existingCodes = new Set(data.coupons.map((item) => String(item.code || '').toUpperCase()));
    const created = [];
    for (let i = 0; i < count; i += 1) {
      let code = createCouponCode();
      while (existingCodes.has(code)) {
        code = createCouponCode();
      }
      existingCodes.add(code);
      const coupon = {
        id: data.nextCouponId++,
        code,
        points: pointValue,
        status: 'unused',
        createdBy,
        createdAt: new Date().toISOString(),
        redeemedBy: '',
        redeemedByUserId: null,
        redeemedAt: ''
      };
      data.coupons.push(coupon);
      created.push(sanitizeCoupon(coupon));
    }

    return created;
  });
}

async function listCoupons({ limit = 200 } = {}) {
  const data = await readData();
  const safeLimit = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || 200));
  return data.coupons
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, safeLimit)
    .map(sanitizeCoupon);
}

async function getAdminStats() {
  const data = await readData();
  const totalUsers = data.users.length;
  const totalCoupons = data.coupons.length;
  const usedCoupons = data.coupons.filter((item) => item.status === 'used').length;
  const totalIssuedPoints = data.coupons.reduce((sum, item) => sum + Number(item.points || 0), 0);
  const totalRemainingPoints = data.users.reduce((sum, item) => sum + Number(item.points || 0), 0);
  return {
    totalUsers,
    totalCoupons,
    usedCoupons,
    unusedCoupons: Math.max(0, totalCoupons - usedCoupons),
    totalIssuedPoints,
    totalRemainingPoints
  };
}

module.exports = {
  registerUser,
  loginUser,
  getUserById,
  redeemCoupon,
  consumePoint,
  refundPoint,
  generateCoupons,
  listCoupons,
  getAdminStats
};

