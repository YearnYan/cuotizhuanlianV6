// 错题啄木鸟 - 前端应用
const API_BASE = '/api';
const SETTINGS_KEY = 'exam_settings_v5';
const RUNTIME_CONFIG_URL = `${API_BASE}/exam/runtime-config`;
const FALLBACK_MAX_UPLOAD_SIZE_BYTES = 8 * 1024 * 1024;
const FALLBACK_COUNT_LIMITS = { min: 1, max: 5 };
const DEFAULT_PREVIEW_TITLE = '错题啄木鸟专练试卷';
const ENGLISH_SUBJECT_PATTERN = /(英语|english)/i;
const AUTH_TOKEN_STORAGE_KEY = 'wd_auth_token_v1';
const AUTH_API = {
    register: `${API_BASE}/auth/register`,
    login: `${API_BASE}/auth/login`,
    me: `${API_BASE}/auth/me`,
    redeem: `${API_BASE}/auth/redeem`
};

const state = {
    generatedQuestions: [],
    selectedQuestions: new Set(),
    currentExamData: null,
    mode: 'select',
    figureCache: new Map(),
    pendingFigures: [],
    activeGenerateToken: 0,
    activeFigureLoadToken: 0,
    wrongQuestion: null,
    analysis: null,
    runtimeConfig: null,
    savedQuestionTypes: [],
    savedQuestionTypeCounts: {},
    lastPreviewTitle: '',
    lastPreviewGroups: null,
    auth: {
        token: '',
        user: null,
        loading: false
    }
};

const scriptPromiseCache = new Map();
let pdfJsReadyPromise = null;

const PDF_JS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js';
const PDF_JS_WORKER_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';

document.addEventListener('DOMContentLoaded', () => {
    const paperTitle = document.getElementById('paperTitle');
    const titleHint = document.getElementById('titleEditHint');
    if (paperTitle && titleHint) {
        paperTitle.addEventListener('focus', () => { titleHint.style.opacity = '0'; });
        paperTitle.addEventListener('blur', () => { titleHint.style.display = 'none'; });
    }

    bootstrapApp().catch((error) => {
        console.error('初始化失败:', error);
    });
});

async function bootstrapApp() {
    initAuthState();
    await refreshCurrentUser();
    await loadRuntimeConfig();
    loadSettings();
    renderQuestionTypes();
    applyQuestionTypeCountsToInputs();
    applyAnswerVisibility();
    updateLiveOriginalPanel();

    if (typeof ensureRequestToken === 'function') {
        ensureRequestToken().catch(() => {});
    }
}

function initAuthState() {
    state.auth.token = String(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || '').trim();
}

function setAuthToken(token) {
    const finalToken = String(token || '').trim();
    state.auth.token = finalToken;
    if (finalToken) {
        localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, finalToken);
    } else {
        localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    }
}

function getAuthHeaders(headers = {}) {
    const merged = { ...headers };
    if (state.auth.token) {
        merged.Authorization = `Bearer ${state.auth.token}`;
    }
    return merged;
}

function isLoggedIn() {
    return Boolean(state.auth.token && state.auth.user);
}

function updateAuthPanel(message = '') {
    const nameEl = document.getElementById('authUserName');
    const pointsEl = document.getElementById('authUserPoints');
    const tipEl = document.getElementById('authTip');
    const logoutBtn = document.getElementById('logoutBtn');
    const redeemBtn = document.getElementById('redeemCouponBtn');

    if (nameEl) {
        nameEl.textContent = state.auth.user?.username || '未登录';
    }
    if (pointsEl) {
        pointsEl.textContent = String(state.auth.user?.points ?? 0);
    }
    if (logoutBtn) {
        logoutBtn.style.display = isLoggedIn() ? 'inline-block' : 'none';
    }
    if (redeemBtn) {
        redeemBtn.style.display = isLoggedIn() ? 'inline-block' : 'inline-block';
    }
    if (tipEl) {
        if (message) {
            tipEl.textContent = message;
        } else if (!isLoggedIn()) {
            tipEl.textContent = '请先注册或登录，再上传错题并生成题目。';
        } else if (Number(state.auth.user?.points || 0) <= 0) {
            tipEl.textContent = '积分不足，请先兑换积分后再生成题目（每次生成消耗1积分）。';
        } else {
            tipEl.textContent = '已登录，可上传错题并生成题目（每次生成消耗1积分）。';
        }
    }
}

async function refreshCurrentUser() {
    if (!state.auth.token) {
        state.auth.user = null;
        updateAuthPanel();
        return;
    }
    try {
        const resp = await apiFetch(AUTH_API.me, {
            method: 'GET',
            headers: getAuthHeaders()
        });
        if (!resp.ok) {
            setAuthToken('');
            state.auth.user = null;
            updateAuthPanel();
            return;
        }
        const data = await resp.json();
        state.auth.user = data.user || null;
        updateAuthPanel();
    } catch {
        setAuthToken('');
        state.auth.user = null;
        updateAuthPanel();
    }
}

function requireLoginOrAlert() {
    if (isLoggedIn()) return true;
    alert('请先注册或登录账号');
    openAuthModal();
    return false;
}

function openAuthModal() {
    const modal = document.getElementById('authModal');
    if (modal) modal.classList.add('show');
}

function openRedeemModal() {
    if (!requireLoginOrAlert()) return;
    const modal = document.getElementById('redeemModal');
    if (modal) modal.classList.add('show');
}

function setModalTip(id, text, isError = false) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    el.style.color = isError ? '#ff8f8f' : 'var(--text-dim)';
}

async function registerAccount() {
    const username = String(document.getElementById('authUsername')?.value || '').trim();
    const password = String(document.getElementById('authPassword')?.value || '');
    setModalTip('authModalTip', '正在注册...');
    try {
        const resp = await apiFetch(AUTH_API.register, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            throw new Error(data.error || '注册失败');
        }
        setAuthToken(data.token || '');
        state.auth.user = data.user || null;
        await loadRuntimeConfig();
        renderQuestionTypes();
        applyQuestionTypeCountsToInputs();
        updateAuthPanel('注册成功，欢迎使用错题啄木鸟');
        setModalTip('authModalTip', '注册成功');
        closeModal('authModal');
    } catch (error) {
        setModalTip('authModalTip', error.message || '注册失败', true);
    }
}

async function loginAccount() {
    const username = String(document.getElementById('authUsername')?.value || '').trim();
    const password = String(document.getElementById('authPassword')?.value || '');
    setModalTip('authModalTip', '正在登录...');
    try {
        const resp = await apiFetch(AUTH_API.login, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            throw new Error(data.error || '登录失败');
        }
        setAuthToken(data.token || '');
        state.auth.user = data.user || null;
        await loadRuntimeConfig();
        renderQuestionTypes();
        applyQuestionTypeCountsToInputs();
        updateAuthPanel('登录成功');
        setModalTip('authModalTip', '登录成功');
        closeModal('authModal');
    } catch (error) {
        setModalTip('authModalTip', error.message || '登录失败', true);
    }
}

function logoutAccount() {
    setAuthToken('');
    state.auth.user = null;
    updateAuthPanel('已退出登录');
}

async function redeemPoints() {
    if (!requireLoginOrAlert()) return;
    const code = String(document.getElementById('redeemCodeInput')?.value || '').trim();
    setModalTip('redeemTip', '正在兑换...');
    try {
        const resp = await apiFetch(AUTH_API.redeem, {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ code })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            throw new Error(data.error || '兑换失败');
        }
        state.auth.user = data.user || state.auth.user;
        updateAuthPanel(`兑换成功，当前积分：${state.auth.user?.points ?? 0}`);
        setModalTip('redeemTip', '兑换成功');
        const input = document.getElementById('redeemCodeInput');
        if (input) input.value = '';
    } catch (error) {
        setModalTip('redeemTip', error.message || '兑换失败', true);
    }
}

function buildFallbackRuntimeConfig() {
    const questionTypes = [];
    const defaultTypeCounts = {};
    const countValues = [];
    const typeOrders = { other: 99 };

    const rows = document.querySelectorAll('.type-count-row');
    rows.forEach((row) => {
        const label = row.querySelector('.type-count-label')?.textContent?.trim();
        const select = row.querySelector('select[id^="count_"]');
        if (!label || !select) return;

        const code = String(select.id || '').replace(/^count_/, '').trim();
        if (!code) return;

        const selectedValue = parseInt(select.value, 10);
        defaultTypeCounts[code] = Number.isFinite(selectedValue) ? selectedValue : 1;

        for (const option of Array.from(select.options)) {
            const value = parseInt(option.value, 10);
            if (Number.isFinite(value)) {
                countValues.push(value);
            }
        }

        questionTypes.push({ label, code });
        typeOrders[String(code).toLowerCase()] = questionTypes.length;
    });

    const minCount = countValues.length > 0 ? Math.min(...countValues) : FALLBACK_COUNT_LIMITS.min;
    const maxCount = countValues.length > 0 ? Math.max(...countValues) : FALLBACK_COUNT_LIMITS.max;
    const fileInput = document.getElementById('wrongQuestionFile');
    const accept = String(fileInput?.getAttribute('accept') || '');
    const allowedMimeTypes = accept
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
        .map((token) => {
            if (token === '.jpg') return 'image/jpeg';
            if (token === '.jpeg') return 'image/jpeg';
            if (token === '.png') return 'image/png';
            if (token === '.pdf') return 'application/pdf';
            return '';
        })
        .filter(Boolean);
    const uniqueAllowedMimeTypes = Array.from(new Set(allowedMimeTypes));

    return {
        upload: {
            maxUploadSizeBytes: FALLBACK_MAX_UPLOAD_SIZE_BYTES,
            allowedMimeTypes: uniqueAllowedMimeTypes
        },
        practice: {
            questionTypes,
            defaultTypeCounts,
            typeOrders,
            countLimits: { min: minCount, max: maxCount }
        }
    };
}

function normalizeRuntimeConfig(rawConfig) {
    const fallback = buildFallbackRuntimeConfig();
    if (!rawConfig || typeof rawConfig !== 'object') return fallback;

    const uploadConfig = rawConfig.upload && typeof rawConfig.upload === 'object'
        ? rawConfig.upload
        : {};
    const practiceConfig = rawConfig.practice && typeof rawConfig.practice === 'object'
        ? rawConfig.practice
        : {};

    const questionTypes = Array.isArray(practiceConfig.questionTypes)
        ? practiceConfig.questionTypes
            .map((item) => ({
                label: String(item?.label || '').trim(),
                code: String(item?.code || '').trim()
            }))
            .filter((item) => item.label && item.code)
        : [];

    const normalizedQuestionTypes = questionTypes.length > 0
        ? questionTypes
        : fallback.practice.questionTypes;

    const countLimitsRaw = practiceConfig.countLimits && typeof practiceConfig.countLimits === 'object'
        ? practiceConfig.countLimits
        : {};
    const minCount = Number.isFinite(parseInt(countLimitsRaw.min, 10))
        ? parseInt(countLimitsRaw.min, 10)
        : fallback.practice.countLimits.min;
    const maxCount = Number.isFinite(parseInt(countLimitsRaw.max, 10))
        ? parseInt(countLimitsRaw.max, 10)
        : fallback.practice.countLimits.max;
    const normalizedMinCount = Math.min(minCount, maxCount);
    const normalizedMaxCount = Math.max(minCount, maxCount);

    const defaultTypeCounts = {};
    const rawDefaultTypeCounts = practiceConfig.defaultTypeCounts && typeof practiceConfig.defaultTypeCounts === 'object'
        ? practiceConfig.defaultTypeCounts
        : {};

    for (const item of normalizedQuestionTypes) {
        const parsed = parseInt(rawDefaultTypeCounts[item.code], 10);
        const fallbackValue = fallback.practice.defaultTypeCounts[item.code] ?? normalizedMinCount;
        const rawValue = Number.isFinite(parsed) ? parsed : fallbackValue;
        defaultTypeCounts[item.code] = Math.min(normalizedMaxCount, Math.max(normalizedMinCount, rawValue));
    }

    const allowedMimeTypes = Array.isArray(uploadConfig.allowedMimeTypes)
        ? uploadConfig.allowedMimeTypes
            .map((item) => String(item || '').trim())
            .filter(Boolean)
        : [];

    const maxUploadSizeBytesParsed = parseInt(uploadConfig.maxUploadSizeBytes, 10);
    const maxUploadSizeBytes = Number.isFinite(maxUploadSizeBytesParsed) && maxUploadSizeBytesParsed > 0
        ? maxUploadSizeBytesParsed
        : fallback.upload.maxUploadSizeBytes;

    const typeOrders = {};
    const typeOrdersRaw = practiceConfig.typeOrders && typeof practiceConfig.typeOrders === 'object'
        ? practiceConfig.typeOrders
        : fallback.practice.typeOrders;
    for (const [key, value] of Object.entries(typeOrdersRaw || {})) {
        const parsed = parseInt(value, 10);
        if (!Number.isFinite(parsed)) continue;
        typeOrders[String(key).trim().toLowerCase()] = parsed;
    }

    return {
        upload: {
            maxUploadSizeBytes,
            allowedMimeTypes: allowedMimeTypes.length > 0
                ? allowedMimeTypes
                : fallback.upload.allowedMimeTypes
        },
        practice: {
            questionTypes: normalizedQuestionTypes,
            defaultTypeCounts,
            typeOrders,
            countLimits: {
                min: normalizedMinCount,
                max: normalizedMaxCount
            }
        }
    };
}

async function loadRuntimeConfig() {
    try {
        const resp = await fetch(RUNTIME_CONFIG_URL, {
            method: 'GET',
            cache: 'no-store',
            credentials: 'same-origin'
        });

        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }

        const data = await resp.json();
        state.runtimeConfig = normalizeRuntimeConfig(data);
    } catch (error) {
        console.warn('获取运行配置失败，已回退到本地配置:', error.message);
        state.runtimeConfig = buildFallbackRuntimeConfig();
    }
}

function getPracticeQuestionTypes() {
    return Array.isArray(state.runtimeConfig?.practice?.questionTypes)
        ? state.runtimeConfig.practice.questionTypes
        : [];
}

function getPracticeCountLimits() {
    const limits = state.runtimeConfig?.practice?.countLimits;
    const min = Number.isFinite(parseInt(limits?.min, 10))
        ? parseInt(limits.min, 10)
        : FALLBACK_COUNT_LIMITS.min;
    const max = Number.isFinite(parseInt(limits?.max, 10))
        ? parseInt(limits.max, 10)
        : FALLBACK_COUNT_LIMITS.max;
    return {
        min: Math.min(min, max),
        max: Math.max(min, max)
    };
}

function getDefaultTypeCounts() {
    const defaults = state.runtimeConfig?.practice?.defaultTypeCounts;
    return defaults && typeof defaults === 'object' ? defaults : {};
}

function getAllowedUploadMimeTypes() {
    const uploadConfig = state.runtimeConfig?.upload;
    if (Array.isArray(uploadConfig?.allowedMimeTypes) && uploadConfig.allowedMimeTypes.length > 0) {
        return uploadConfig.allowedMimeTypes;
    }
    const fallback = buildFallbackRuntimeConfig();
    return Array.isArray(fallback.upload?.allowedMimeTypes) ? fallback.upload.allowedMimeTypes : [];
}

function getMaxUploadSizeBytes() {
    const uploadConfig = state.runtimeConfig?.upload;
    const parsed = parseInt(uploadConfig?.maxUploadSizeBytes, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }
    return FALLBACK_MAX_UPLOAD_SIZE_BYTES;
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function renderQuestionTypes() {
    const container = document.getElementById('questionTypeContainer');
    if (!container) return;

    const practiceTypes = getPracticeQuestionTypes();
    if (practiceTypes.length === 0) {
        container.innerHTML = '<span style="color:#8892b0;font-size:12px">题型加载失败，请刷新重试</span>';
        return;
    }

    const selected = new Set(
        state.savedQuestionTypes || practiceTypes.map((item) => item.label)
    );

    container.innerHTML = '';
    practiceTypes.forEach((item) => {
        const tag = document.createElement('span');
        tag.className = 'qtype-tag';
        if (selected.has(item.label)) {
            tag.classList.add('active');
        }
        tag.textContent = item.label;
        tag.dataset.type = item.label;
        tag.onclick = () => {
            tag.classList.toggle('active');
            saveSettings();
        };
        container.appendChild(tag);
    });
}

function getSelectedQuestionTypes() {
    const tags = document.querySelectorAll('#questionTypeContainer .qtype-tag.active');
    return Array.from(tags).map((tag) => tag.dataset.type).filter(Boolean);
}

function clampTypeCount(value) {
    const limits = getPracticeCountLimits();
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        const defaults = getDefaultTypeCounts();
        const firstDefault = parseInt(Object.values(defaults)[0], 10);
        if (Number.isFinite(firstDefault)) {
            return Math.min(limits.max, Math.max(limits.min, firstDefault));
        }
        return Math.min(limits.max, Math.max(limits.min, 1));
    }
    return Math.min(limits.max, Math.max(limits.min, parsed));
}

function normalizeQuestionTypeCounts(raw) {
    const practiceTypes = getPracticeQuestionTypes();
    const defaultTypeCounts = getDefaultTypeCounts();
    const counts = {};
    for (const item of practiceTypes) {
        counts[item.code] = clampTypeCount(defaultTypeCounts[item.code]);
    }

    if (!raw || typeof raw !== 'object') return counts;

    for (const item of practiceTypes) {
        counts[item.code] = clampTypeCount(raw[item.code]);
    }
    return counts;
}

function applyQuestionTypeCountsToInputs() {
    const counts = normalizeQuestionTypeCounts(state.savedQuestionTypeCounts);
    state.savedQuestionTypeCounts = counts;
    const limits = getPracticeCountLimits();

    for (const item of getPracticeQuestionTypes()) {
        const el = document.getElementById(`count_${item.code}`);
        if (!el) continue;
        el.min = String(limits.min);
        el.max = String(limits.max);
        el.value = String(counts[item.code]);
    }
}

function getQuestionTypeCounts() {
    const counts = {};
    const defaultTypeCounts = getDefaultTypeCounts();
    for (const item of getPracticeQuestionTypes()) {
        const el = document.getElementById(`count_${item.code}`);
        counts[item.code] = clampTypeCount(el?.value ?? defaultTypeCounts[item.code]);
    }
    return counts;
}

function buildSelectedTypeCounts(selectedTypes) {
    const allCounts = getQuestionTypeCounts();
    const selected = {};
    const defaultTypeCounts = getDefaultTypeCounts();
    const practiceTypes = getPracticeQuestionTypes();

    selectedTypes.forEach((label) => {
        const type = practiceTypes.find((item) => item.label === label);
        if (!type) return;
        selected[type.code] = allCounts[type.code] || clampTypeCount(defaultTypeCounts[type.code]);
    });

    return selected;
}

function setUploadStatus(text, status = '') {
    const el = document.getElementById('uploadStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('ok', 'error', 'warn');
    if (status === 'ok') el.classList.add('ok');
    if (status === 'error') el.classList.add('error');
    if (status === 'warn') el.classList.add('warn');
}

function renderWrongQuestionPreview(url) {
    const container = document.getElementById('wrongQuestionPreview');
    if (!container) return;

    if (!url) {
        container.classList.remove('show');
        container.innerHTML = '';
        return;
    }

    container.classList.add('show');
    container.innerHTML = `<img src="${url}" alt="上传错题预览">`;
}

function renderAnalysisResult() {
    const panel = document.getElementById('analysisResult');
    if (!panel) return;

    if (!state.analysis) {
        panel.style.display = 'none';
        return;
    }

    const toListText = (list) => {
        if (!Array.isArray(list) || list.length === 0) return '未识别到';
        return list.map((item) => `• ${escapeHtml(item)}`).join('<br>');
    };

    const knowledgeEl = document.getElementById('analysisKnowledgePoints');
    const examEl = document.getElementById('analysisExamPoints');
    const answerEl = document.getElementById('analysisAnswer');

    if (knowledgeEl) knowledgeEl.innerHTML = toListText(state.analysis.knowledgePoints);
    if (examEl) examEl.innerHTML = toListText(state.analysis.examPoints);
    if (answerEl) answerEl.textContent = state.analysis.answerAnalysis || '未识别到';

    panel.style.display = 'block';
}

function isEnglishSubject(subject) {
    return ENGLISH_SUBJECT_PATTERN.test(String(subject || '').trim());
}

function shouldWarnEnglishWholeQuestion(analysis) {
    if (!analysis || !isEnglishSubject(analysis.subject)) return false;
    if (analysis.needsWholeQuestion) return true;

    const text = String(analysis.originalQuestionText || '').trim();
    const textLen = text.replace(/\s+/g, '').length;
    const markerCount = (text.match(/\b\d{1,2}[\.．、)]|[A-D][\.．、)]/g) || []).length;
    const tags = `${(analysis.knowledgePoints || []).join(' ')} ${(analysis.examPoints || []).join(' ')}`;
    const contextSensitive = /(阅读|完形|语篇|cloze|reading|七选五|短文)/i.test(tags);

    if (!contextSensitive) return false;
    return textLen < 140 || markerCount < 2;
}

async function handleWrongQuestionUpload(inputEl) {
    if (!requireLoginOrAlert()) {
        inputEl.value = '';
        return;
    }

    const file = inputEl?.files?.[0];
    if (!file) return;

    if (inputEl.files.length > 1) {
        alert('每次仅上传1道完整错题（英语请上传整题）。');
        inputEl.value = '';
        return;
    }

    const allowedMimeTypes = getAllowedUploadMimeTypes();
    if (!allowedMimeTypes.length) {
        alert('上传配置加载失败，请刷新后重试');
        inputEl.value = '';
        return;
    }
    const isAllowedType = allowedMimeTypes.includes(file.type);
    if (!isAllowedType) {
        alert(`仅支持 ${allowedMimeTypes.map((type) => type.replace('image/', '').replace('application/', '').toUpperCase()).join('/')} 格式`);
        inputEl.value = '';
        return;
    }

    const maxUploadSizeBytes = getMaxUploadSizeBytes();
    if (file.size > maxUploadSizeBytes) {
        alert(`上传文件过大，请控制在 ${formatBytes(maxUploadSizeBytes)} 以内`);
        inputEl.value = '';
        return;
    }

    setUploadStatus('正在解析错题，请稍候...');
    setGenerateButtonLoading(true, '正在解析错题...');

    try {
        const prepared = await prepareWrongQuestionAsset(file);
        if (!prepared.previewImageUrl) {
            throw new Error('未能提取可识别的题目图片');
        }

        const resp = await apiFetch(`${API_BASE}/exam/analyze-wrong-question`, {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                fileName: file.name,
                mimeType: file.type,
                previewImageUrl: prepared.previewImageUrl,
                extractedText: prepared.extractedText || ''
            })
        });

        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({ error: '解析失败' }));
            if (resp.status === 401) {
                setAuthToken('');
                state.auth.user = null;
                updateAuthPanel('登录已失效，请重新登录');
                openAuthModal();
            }
            throw new Error(errData.error || '解析失败');
        }

        const data = await resp.json();
        state.wrongQuestion = {
            fileName: file.name,
            mimeType: file.type,
            previewImageUrl: prepared.previewImageUrl
        };
        state.analysis = normalizeAnalysisResult(data);
        const needsWholeQuestion = shouldWarnEnglishWholeQuestion(state.analysis);
        const wholeQuestionAdvice = state.analysis.wholeQuestionAdvice || '检测到英语题可能缺少上下文，建议上传包含完整文章与全部小问的一整题。';

        renderWrongQuestionPreview(state.wrongQuestion.previewImageUrl);
        renderAnalysisResult();
        updateLiveOriginalPanel();
        if (needsWholeQuestion) {
            setUploadStatus(wholeQuestionAdvice, 'warn');
        } else {
            setUploadStatus('错题解析完成，可直接生成题目', 'ok');
        }
    } catch (error) {
        console.error('错题解析失败:', error);
        state.wrongQuestion = null;
        state.analysis = null;
        renderWrongQuestionPreview('');
        renderAnalysisResult();
        updateLiveOriginalPanel();
        setUploadStatus(`解析失败：${error.message}`, 'error');
    } finally {
        setGenerateButtonLoading(false);
    }
}

function normalizeAnalysisResult(data) {
    const normalizeList = (list) => {
        if (!Array.isArray(list)) return [];
        return list
            .map((item) => String(item || '').trim())
            .filter(Boolean)
            .slice(0, 8);
    };

    return {
        knowledgePoints: normalizeList(data.knowledgePoints),
        examPoints: normalizeList(data.examPoints),
        answerAnalysis: String(data.answerAnalysis || '').trim(),
        hasFigure: Boolean(data.hasFigure),
        subject: String(data.subject || '').trim(),
        grade: String(data.grade || '').trim(),
        originalQuestionText: String(data.originalQuestionText || '').trim(),
        needsWholeQuestion: Boolean(data.needsWholeQuestion),
        wholeQuestionAdvice: String(data.wholeQuestionAdvice || '').trim()
    };
}

async function prepareWrongQuestionAsset(file) {
    if (file.type === 'application/pdf') {
        return readPdfFirstPage(file);
    }

    const rawDataUrl = await readFileAsDataUrl(file);
    const compressedDataUrl = await compressImageDataUrl(rawDataUrl);
    return {
        previewImageUrl: compressedDataUrl,
        extractedText: ''
    };
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
    });
}

function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片解析失败'));
        img.src = dataUrl;
    });
}

async function compressImageDataUrl(dataUrl) {
    const img = await loadImage(dataUrl);
    const maxSide = 1600;
    const sourceMax = Math.max(img.width, img.height);
    const shouldResize = sourceMax > maxSide;
    const shouldCompress = dataUrl.length > 1_800_000;

    if (!shouldResize && !shouldCompress) return dataUrl;

    const ratio = shouldResize ? (maxSide / sourceMax) : 1;
    const width = Math.max(1, Math.round(img.width * ratio));
    const height = Math.max(1, Math.round(img.height * ratio));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);

    return canvas.toDataURL('image/jpeg', 0.9);
}

async function ensurePdfJs() {
    if (window.pdfjsLib) return window.pdfjsLib;

    if (!pdfJsReadyPromise) {
        pdfJsReadyPromise = loadScript(PDF_JS_CDN).then(() => {
            if (!window.pdfjsLib) throw new Error('PDF解析库加载失败');
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_JS_WORKER_CDN;
            return window.pdfjsLib;
        });
    }

    return pdfJsReadyPromise;
}

async function readPdfFirstPage(file) {
    const pdfjsLib = await ensurePdfJs();
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;

    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1.7 });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');

    await page.render({ canvasContext: ctx, viewport }).promise;

    let extractedText = '';
    try {
        const textContent = await page.getTextContent();
        extractedText = textContent.items
            .map((item) => String(item.str || '').trim())
            .filter(Boolean)
            .join(' ')
            .slice(0, 4000);
    } catch (e) {
        extractedText = '';
    }

    try {
        pdf.cleanup();
        await pdf.destroy();
    } catch (e) {
        // 忽略销毁异常
    }

    return {
        previewImageUrl: canvas.toDataURL('image/png'),
        extractedText
    };
}

function setGenerateButtonLoading(isLoading, text = '') {
    const btn = document.getElementById('generateBtn');
    if (!btn) return;
    const label = btn.querySelector('span') || btn;
    btn.disabled = !!isLoading;
    btn.classList.toggle('is-loading', !!isLoading);
    label.textContent = text || (isLoading ? '正在生成试卷...' : '⚡ 生成题目');
}

function updateFigureProgressBanner(done, total, failed = 0, active = true) {
    const banner = document.getElementById('figureProgressBanner');
    if (banner) banner.remove();
}

async function generateExam() {
    if (!requireLoginOrAlert()) return;
    if (Number(state.auth.user?.points || 0) < 1) {
        alert('积分不足，请先兑换积分后再生成题目（每次生成消耗1积分）');
        openRedeemModal();
        return;
    }

    if (!state.analysis || !state.wrongQuestion) {
        alert('请先上传并解析1道完整错题（英语请上传整题）');
        return;
    }
    if (isEnglishSubject(state.analysis.subject) && state.analysis.needsWholeQuestion) {
        alert(state.analysis.wholeQuestionAdvice || '英语题上下文不足，请上传包含完整文章与全部小问的一整题后再生成。');
        return;
    }

    const selectedQuestionTypes = getSelectedQuestionTypes();
    if (selectedQuestionTypes.length === 0) {
        alert('请至少选择一种题型');
        return;
    }

    const questionTypeCounts = buildSelectedTypeCounts(selectedQuestionTypes);
    const totalQuestionCount = Object.values(questionTypeCounts).reduce((sum, current) => sum + current, 0);
    if (totalQuestionCount <= 0) {
        alert('请设置题目数量');
        return;
    }

    state.activeGenerateToken = Date.now();
    const requestToken = state.activeGenerateToken;

    const loadingEl = document.getElementById('loading');
    const loadingTitle = document.getElementById('loadingTitle');
    const loadingSubtitle = document.getElementById('loadingSubtitle');
    const fakeProgressBar = document.getElementById('fakeProgressBar');
    const fakeProgressText = document.getElementById('fakeProgressText');

    const loadingMessages = [
        { title: '正在生成题目...', subtitle: '正在读取错题解析结果' },
        { title: '正在生成题目...', subtitle: '正在按题型构造相似题与变式题' },
        { title: '正在生成题目...', subtitle: '正在补全答案与解析' },
        { title: '正在生成题目...', subtitle: '正在整理试卷结构' }
    ];

    let messageIndex = 0;
    let fakeProgress = 0;

    loadingEl.style.display = 'flex';
    setGenerateButtonLoading(true, '正在生成题目...');
    if (loadingTitle) loadingTitle.textContent = loadingMessages[0].title;
    if (loadingSubtitle) loadingSubtitle.textContent = loadingMessages[0].subtitle;
    if (fakeProgressBar) fakeProgressBar.style.width = '0%';
    if (fakeProgressText) fakeProgressText.textContent = '0%';

    const messageInterval = setInterval(() => {
        messageIndex = (messageIndex + 1) % loadingMessages.length;
        if (loadingTitle) loadingTitle.textContent = loadingMessages[messageIndex].title;
        if (loadingSubtitle) loadingSubtitle.textContent = loadingMessages[messageIndex].subtitle;
    }, 1800);

    const fakeProgressInterval = setInterval(() => {
        if (fakeProgress >= 96) return;
        fakeProgress += 1;
        const progressText = `${fakeProgress}%`;
        if (fakeProgressBar) fakeProgressBar.style.width = progressText;
        if (fakeProgressText) fakeProgressText.textContent = progressText;
    }, 1000);

    switchToSelectMode();
    updateFigureProgressBanner(0, 0, 0, false);

    try {
        const resp = await apiFetch(`${API_BASE}/exam/generate`, {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                subject: state.analysis.subject,
                grade: state.analysis.grade,
                knowledgePoints: state.analysis.knowledgePoints,
                examPoints: state.analysis.examPoints,
                answerAnalysis: state.analysis.answerAnalysis,
                sourceQuestionText: state.analysis.originalQuestionText,
                sourceQuestionImage: state.wrongQuestion.previewImageUrl,
                hasFigure: state.analysis.hasFigure,
                questionTypes: selectedQuestionTypes,
                questionTypeCounts,
                questionCount: totalQuestionCount
            })
        });

        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({ error: '生成失败' }));
            if (resp.status === 401) {
                setAuthToken('');
                state.auth.user = null;
                updateAuthPanel('登录已失效，请重新登录');
                openAuthModal();
            }
            alert('生成失败：' + (errData.error || '未知错误'));
            return;
        }

        const data = await resp.json();
        if (requestToken !== state.activeGenerateToken) return;
        if (Number.isFinite(Number.parseInt(data.userPoints, 10)) && state.auth.user) {
            state.auth.user.points = Number.parseInt(data.userPoints, 10);
            updateAuthPanel();
        }

        if (data.questions && Array.isArray(data.questions) && data.questions.length > 0) {
            state.currentExamData = data;
            renderQuestionCards(data, requestToken);
        } else if (data.error) {
            alert('生成失败：' + data.error);
        } else {
            alert('生成结果格式异常，请重试');
        }
    } catch (e) {
        console.error('生成题目异常:', e);
        alert('生成失败：' + e.message);
    } finally {
        clearInterval(messageInterval);
        clearInterval(fakeProgressInterval);
        if (requestToken === state.activeGenerateToken) {
            loadingEl.style.display = 'none';
            setGenerateButtonLoading(false);
        }
    }
}

function renderQuestionCards(data, figureLoadToken = Date.now()) {
    const container = document.getElementById('selectMode');
    const composeBar = document.getElementById('composeBar');
    let html = '';
    let globalIndex = 0;

    state.generatedQuestions = [];
    state.selectedQuestions.clear();
    state.activeFigureLoadToken = figureLoadToken;
    state.pendingFigures = [];

    const figureSubject = state.analysis?.subject || data?.metadata?.subject || '数学';

    if (data.questions && Array.isArray(data.questions)) {
        for (const group of data.questions) {
            if (!group || !Array.isArray(group.items)) continue;
            html += `<div class="group-header">${escapeHtml(group.title || '')}</div>`;
            for (const item of group.items) {
                if (!item) continue;
                const idx = globalIndex++;
                state.generatedQuestions.push({ ...item, groupType: group.type, groupTitle: group.title });

                html += `<div class="question-card" data-idx="${idx}" onclick="toggleQuestion(${idx})">`;
                html += '<div class="select-check">&#10003;</div>';
                html += `<div class="q-stem">${item.index || ''}. ${escapeHtml(item.stem || '')}</div>`;

                if (Array.isArray(item.options) && item.options.length > 0) {
                    html += `<div class="q-options">${item.options.filter(Boolean).map((opt) => `<div class="q-option">${escapeHtml(opt)}</div>`).join('')}</div>`;
                }

                if (item.figure) {
                    const figId = `fig_${idx}_${Date.now()}`;
                    html += `<div class="q-figure q-figure-loading" id="${figId}" style="min-height:60px;border:1px dashed #ddd;padding:10px;text-align:center;border-radius:4px;background:#fafafa">`;
                    html += '<span style="color:#999;font-size:12px">图形排队中...</span>';
                    html += '</div>';
                    state.pendingFigures.push({
                        id: figId,
                        qIdx: idx,
                        figure: item.figure,
                        stem: item.stem || '',
                        subject: figureSubject
                    });
                }

                html += '</div>';
            }
        }
    }

    container.innerHTML = html;
    composeBar.style.display = 'flex';
    updateSelectedCount();
    loadFiguresAsync(figureLoadToken);
}

async function loadSingleFigure(fig, figureLoadToken, retryCount = 0) {
    if (figureLoadToken !== state.activeFigureLoadToken) return false;

    const desc = typeof fig.figure === 'string'
        ? fig.figure
        : (fig.figure.description || fig.figure.code || '');
    const el = document.getElementById(fig.id);
    if (!el) return false;

    if (!desc) {
        el.style.display = 'none';
        return false;
    }

    try {
        el.innerHTML = `<span style="color:#999;font-size:12px">${retryCount > 0 ? '图形重试中...' : '图形生成中...'}</span>`;

        const resp = await apiFetch(`${API_BASE}/render/figure`, {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                description: desc,
                stem: fig.stem || '',
                subject: fig.subject
            })
        });

        if (!resp.ok) {
            if (resp.status === 401) {
                setAuthToken('');
                state.auth.user = null;
                updateAuthPanel('登录已失效，请重新登录');
            }
            throw new Error(`HTTP ${resp.status}`);
        }
        const data = await resp.json();

        if (figureLoadToken !== state.activeFigureLoadToken) return false;

        if (data.svg) {
            el.innerHTML = data.svg;
            el.style.border = 'none';
            el.style.background = 'transparent';
            el.classList.remove('q-figure-loading');
            if (fig.qIdx !== undefined) {
                state.figureCache.set(fig.qIdx, data.svg);
            }
            return true;
        }
    } catch (e) {
        if (retryCount < 1) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            return loadSingleFigure(fig, figureLoadToken, retryCount + 1);
        }
    }

    if (figureLoadToken !== state.activeFigureLoadToken) return false;
    const lastEl = document.getElementById(fig.id);
    if (lastEl) lastEl.style.display = 'none';
    return false;
}

async function loadFiguresAsync(figureLoadToken) {
    if (!state.pendingFigures || state.pendingFigures.length === 0) {
        updateFigureProgressBanner(0, 0, 0, false);
        return;
    }
    if (figureLoadToken !== state.activeFigureLoadToken) return;

    const figures = state.pendingFigures;
    state.pendingFigures = [];

    const total = figures.length;
    let done = 0;
    let failed = 0;
    let cursor = 0;

    updateFigureProgressBanner(done, total, failed, true);

    const workerCount = 1;
    const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < total) {
            if (figureLoadToken !== state.activeFigureLoadToken) return;
            const current = cursor++;
            const fig = figures[current];
            const ok = await loadSingleFigure(fig, figureLoadToken);
            done += 1;
            if (!ok) failed += 1;
            if (figureLoadToken === state.activeFigureLoadToken) {
                updateFigureProgressBanner(done, total, failed, done < total);
            }
        }
    });

    await Promise.all(workers);
    if (figureLoadToken === state.activeFigureLoadToken) {
        updateFigureProgressBanner(done, total, failed, false);
    }
}

function toggleQuestion(idx) {
    if (state.selectedQuestions.has(idx)) state.selectedQuestions.delete(idx);
    else state.selectedQuestions.add(idx);

    const card = document.querySelector(`.question-card[data-idx="${idx}"]`);
    if (card) card.classList.toggle('selected');
    updateSelectedCount();
}

function updateSelectedCount() {
    const count = state.selectedQuestions.size;
    document.getElementById('selectedCount').textContent = count;
    document.getElementById('composeBtn').disabled = count === 0;
}

function composeExam() {
    if (state.selectedQuestions.size === 0) {
        alert('请至少选择一道题目');
        return;
    }

    const selectedIndices = Array.from(state.selectedQuestions).sort((a, b) => a - b);

    const groups = {};
    selectedIndices.forEach((idx) => {
        const q = state.generatedQuestions[idx];
        if (!q) return;

        const type = q.groupType || 'other';
        if (!groups[type]) {
            groups[type] = {
                title: q.groupTitle,
                items: [],
                order: getTypeOrder(type)
            };
        }
        groups[type].items.push({ ...q, originalIdx: idx });
    });

    const sortedGroups = Object.entries(groups).sort((a, b) => a[1].order - b[1].order);

    let num = 1;
    sortedGroups.forEach(([, group]) => {
        group.items.forEach((item) => { item.index = num++; });
    });

    const groupsObj = Object.fromEntries(sortedGroups);
    const previewTitle = state.currentExamData?.title || DEFAULT_PREVIEW_TITLE;
    state.lastPreviewTitle = previewTitle;
    state.lastPreviewGroups = groupsObj;

    renderExamPreview(previewTitle, groupsObj);
    switchToPreviewMode();
}

function normalizeQuestionType(type) {
    const text = String(type || '').toLowerCase();
    if (text.includes('相似') || text.includes('similar')) return 'similar';
    if (text.includes('变式') || text.includes('variant')) return 'variant';
    if (text.includes('综合应用') || text.includes('application')) return 'application';
    if (text.includes('choice') || text.includes('选择')) return 'choice';
    if (text.includes('fill') || text.includes('blank') || text.includes('填空')) return 'blank';
    if (text.includes('calculation') || text.includes('qa') || text.includes('解答') || text.includes('计算')) return 'qa';
    return 'other';
}

function getTypeOrder(type) {
    const normalized = normalizeQuestionType(type);
    const typeOrders = state.runtimeConfig?.practice?.typeOrders;
    if (typeOrders && typeof typeOrders === 'object') {
        const explicit = parseInt(typeOrders[normalized], 10);
        if (Number.isFinite(explicit)) return explicit;
        const original = parseInt(typeOrders[String(type || '').trim().toLowerCase()], 10);
        if (Number.isFinite(original)) return original;
        const fallback = parseInt(typeOrders.other, 10);
        if (Number.isFinite(fallback)) return fallback;
    }
    return 999;
}

function buildOriginalQuestionHtml() {
    if (!state.wrongQuestion?.previewImageUrl) return '';
    const showOriginal = document.getElementById('showOriginal')?.checked;
    if (!showOriginal) return '';

    return `
        <div class="original-question-block">
            <div class="group-title">原题展示</div>
            <div class="original-question-image">
                <img src="${state.wrongQuestion.previewImageUrl}" alt="原题图片">
            </div>
        </div>
    `;
}

function renderExamPreview(title, groups) {
    const titleHint = document.getElementById('titleEditHint');
    if (titleHint) {
        titleHint.style.display = '';
        titleHint.style.opacity = '1';
    }

    document.getElementById('paperTitle').textContent = title;
    let html = buildOriginalQuestionHtml();

    for (const [, group] of Object.entries(groups)) {
        if (!group || !group.items || group.items.length === 0) continue;

        html += `<div class="question-group"><div class="group-title">${escapeHtml(group.title || '')}</div>`;

        for (const item of group.items) {
            if (!item) continue;

            html += `<div class="question-item"><div class="q-stem">${item.index}. ${escapeHtml(item.stem || '')}</div>`;

            if (Array.isArray(item.options) && item.options.length > 0) {
                html += `<div class="q-options">${item.options.filter(Boolean).map((opt) => `<div class="q-option">${escapeHtml(opt)}</div>`).join('')}</div>`;
            }

            if (item.figure) {
                const cachedSvg = state.figureCache.get(item.originalIdx);
                if (cachedSvg) {
                    html += `<div class="q-figure" style="text-align:center">${cachedSvg}</div>`;
                }
            }

            html += '</div>';
        }
        html += '</div>';
    }

    const examContent = document.getElementById('examContent');
    if (!examContent) return;

    examContent.innerHTML = html;

    if (state.currentExamData?.answers) {
        const indices = [...state.selectedQuestions].sort((a, b) => a - b);
        const answers = indices.map((idx, i) => {
            const orig = state.currentExamData.answers[idx];
            return orig ? `${i + 1}. ${String(orig).replace(/^\d+\.\s*/, '')}` : '';
        }).filter(Boolean);

        document.getElementById('answerContent').innerHTML = answers.map((a) => `<div>${escapeHtml(a)}</div>`).join('<br>');
    }

    applyAnswerVisibility();
}

function updateLiveOriginalPanel() {
    const panel = document.getElementById('liveOriginalPanel');
    const img = document.getElementById('liveOriginalImage');
    if (!panel || !img) return;

    const showOriginal = document.getElementById('showOriginal')?.checked ?? true;
    const imageUrl = state.wrongQuestion?.previewImageUrl || '';
    const shouldShow = state.mode !== 'preview' && showOriginal && !!imageUrl;

    if (!shouldShow) {
        panel.classList.remove('show');
        img.removeAttribute('src');
        return;
    }

    img.src = imageUrl;
    panel.classList.add('show');
}

function handleShowOriginalChange() {
    saveSettings();
    updateLiveOriginalPanel();

    if (state.mode === 'preview' && state.lastPreviewGroups) {
        renderExamPreview(state.lastPreviewTitle || DEFAULT_PREVIEW_TITLE, state.lastPreviewGroups);
    }
}

function applyAnswerVisibility() {
    const showAnswerCheckbox = document.getElementById('showAnswer');
    const answerArea = document.getElementById('answerArea');
    if (!showAnswerCheckbox || !answerArea) return;
    answerArea.style.display = showAnswerCheckbox.checked ? 'block' : 'none';
}

function switchToSelectMode() {
    state.mode = 'select';
    document.getElementById('selectMode').style.display = 'block';
    document.getElementById('paper').classList.remove('show');
    document.getElementById('downloadBar').classList.remove('show');
    updateLiveOriginalPanel();
}

function switchToPreviewMode() {
    state.mode = 'preview';
    document.getElementById('selectMode').style.display = 'none';
    document.getElementById('composeBar').style.display = 'none';
    const paper = document.getElementById('paper');
    paper.classList.add('show');
    document.getElementById('downloadBar').classList.add('show');
    updateLiveOriginalPanel();
}

function backToSelect() {
    switchToSelectMode();
    if (state.generatedQuestions.length > 0) {
        document.getElementById('composeBar').style.display = 'flex';
    }
}

async function exportToPdf() {
    const paper = document.getElementById('paper');
    const loadingEl = document.getElementById('loading');
    loadingEl.style.display = 'flex';

    try {
        if (!window.html2pdf) {
            await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js');
        }

        const titleText = document.getElementById('paperTitle').textContent;

        const origStyle = paper.style.cssText;
        paper.style.width = '210mm';
        paper.style.minHeight = '297mm';
        paper.style.maxWidth = '210mm';
        paper.style.padding = '20mm 26mm 25mm 4mm';
        paper.style.margin = '0 auto';
        paper.style.boxShadow = 'none';
        paper.style.display = 'block';

        const sealLine = paper.querySelector('.seal-line');
        if (sealLine) sealLine.style.display = 'none';
        const hint = paper.querySelector('.title-edit-hint');
        if (hint) hint.style.display = 'none';

        const svgBackups = [];
        for (const svg of paper.querySelectorAll('svg')) {
            try {
                const vb = svg.getAttribute('viewBox');
                let w = 400;
                let h = 300;
                if (vb) {
                    const p = vb.split(/[\s,]+/);
                    w = parseFloat(p[2]) || 400;
                    h = parseFloat(p[3]) || 300;
                }
                const svgClone = svg.cloneNode(true);
                if (!svgClone.getAttribute('xmlns')) {
                    svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
                }
                svgClone.setAttribute('width', w);
                svgClone.setAttribute('height', h);
                const svgStr = new XMLSerializer().serializeToString(svgClone);
                const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const cvs = document.createElement('canvas');
                cvs.width = w * 2;
                cvs.height = h * 2;
                const ctx = cvs.getContext('2d');
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, cvs.width, cvs.height);
                ctx.scale(2, 2);
                const img = new Image();
                await new Promise((ok, fail) => {
                    img.onload = ok;
                    img.onerror = fail;
                    img.src = url;
                });
                ctx.drawImage(img, 0, 0, w, h);
                URL.revokeObjectURL(url);
                cvs.style.cssText = 'max-width:250px;height:auto;display:block;margin:8px auto';
                svgBackups.push({ svg, parent: svg.parentNode });
                svg.parentNode.replaceChild(cvs, svg);
            } catch (e) {
                // 忽略单个SVG转码失败
            }
        }

        await html2pdf().set({
            margin: [10, 10, 10, 10],
            filename: `${titleText}.pdf`,
            image: { type: 'jpeg', quality: 0.95 },
            html2canvas: { scale: 2, useCORS: true, backgroundColor: '#fff' },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
            pagebreak: { mode: ['css', 'legacy'], avoid: '.question-item' }
        }).from(paper).save();

        const allCanvas = paper.querySelectorAll('canvas');
        svgBackups.forEach(({ svg }, i) => {
            try {
                allCanvas[i].parentNode.replaceChild(svg, allCanvas[i]);
            } catch (e) {
                // 忽略恢复失败
            }
        });
        if (sealLine) sealLine.style.display = '';
        if (hint) hint.style.display = '';
        paper.style.cssText = origStyle;
    } catch (e) {
        console.error('PDF导出失败:', e);
        alert('PDF导出失败，请尝试Ctrl+P打印');
    }
    loadingEl.style.display = 'none';
}

async function exportToWord() {
    const titleText = document.getElementById('paperTitle').textContent;
    const showAnswer = document.getElementById('showAnswer').checked;
    const loadingEl = document.getElementById('loading');
    loadingEl.style.display = 'flex';

    try {
        const svgImgMap = new Map();
        const svgs = document.querySelectorAll('#examContent svg, #answerContent svg');
        for (const svg of svgs) {
            try {
                const vb = svg.getAttribute('viewBox');
                let w = 400;
                let h = 300;
                if (vb) {
                    const p = vb.split(/[\s,]+/);
                    w = parseFloat(p[2]) || 400;
                    h = parseFloat(p[3]) || 300;
                }

                const svgClone = svg.cloneNode(true);
                if (!svgClone.getAttribute('xmlns')) {
                    svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
                }
                svgClone.setAttribute('width', w);
                svgClone.setAttribute('height', h);

                const svgStr = new XMLSerializer().serializeToString(svgClone);
                const svgB64 = btoa(unescape(encodeURIComponent(svgStr)));

                const canvas = document.createElement('canvas');
                canvas.width = w * 2;
                canvas.height = h * 2;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.scale(2, 2);

                const img = new Image();
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = reject;
                    img.src = `data:image/svg+xml;base64,${svgB64}`;
                });
                ctx.drawImage(img, 0, 0, w, h);

                const figDiv = svg.closest('.q-figure');
                if (figDiv) {
                    svgImgMap.set(figDiv, canvas.toDataURL('image/png'));
                }
            } catch (e) {
                console.warn('SVG转换失败:', e);
            }
        }

        let questionsHtml = '';
        const examContent = document.getElementById('examContent');
        for (const child of examContent.children) {
            let childHtml = child.outerHTML;
            const figDivs = child.querySelectorAll('.q-figure');
            for (const figDiv of figDivs) {
                const base64 = svgImgMap.get(figDiv);
                if (base64) {
                    const imgTag = `<p style="text-align:center;margin:10px 0"><img src="${base64}" width="200" height="auto" style="max-width:200px"></p>`;
                    childHtml = childHtml.replace(figDiv.outerHTML, imgTag);
                } else {
                    childHtml = childHtml.replace(figDiv.outerHTML, '');
                }
            }
            questionsHtml += childHtml;
        }

        let answerHtml = '';
        if (showAnswer) {
            answerHtml = document.getElementById('answerContent').innerHTML;
        }

        const wordHtml = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><meta charset='utf-8'><title>${titleText}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
@page { size: A4; margin: 2.5cm 2cm 3cm 2cm; }
body { font-family: '宋体', SimSun, serif; font-size: 12pt; line-height: 1.8; color: #000; }
.exam-header { text-align: center; border-bottom: 2pt solid #000; padding-bottom: 8pt; margin-bottom: 16pt; }
.exam-title { font-size: 18pt; font-weight: bold; margin-bottom: 12pt; }
.secret-mark { text-align: left; font-size: 9pt; font-weight: bold; margin-bottom: 8pt; }
.exam-info { text-align: center; font-size: 12pt; margin-top: 12pt; }
.question-group { margin-bottom: 16pt; }
.group-title { font-weight: bold; font-size: 14pt; margin-bottom: 8pt; }
.question-item { margin-bottom: 12pt; font-size: 12pt; line-height: 1.8; }
.q-stem { font-weight: normal; margin-bottom: 4pt; }
.q-options { margin-left: 2em; }
.q-option { display: inline-block; min-width: 22%; margin-right: 0.25em; }
.answer-key { margin-top: 30pt; border-top: 1pt dashed #999; padding-top: 16pt; }
.answer-key .group-title { font-weight: bold; font-size: 14pt; margin-bottom: 8pt; }
</style></head>
<body>
<div class="exam-header">
<div class="secret-mark">绝密 ★ 启用前</div>
<div class="exam-title">${titleText}</div>
<div class="exam-info">姓名：____________ 班级：____________ 考号：____________</div>
</div>
${questionsHtml}
${showAnswer ? `<div class="answer-key"><div class="group-title">参考答案与解析</div>${answerHtml}</div>` : ''}
</body></html>`;

        const blob = new Blob(['\ufeff' + wordHtml], { type: 'application/msword;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${titleText}.doc`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    } catch (e) {
        console.error('Word导出失败:', e);
        alert('Word导出失败: ' + e.message);
    }
    loadingEl.style.display = 'none';
}

function loadScript(src) {
    if (scriptPromiseCache.has(src)) {
        return scriptPromiseCache.get(src);
    }

    const promise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });

    scriptPromiseCache.set(src, promise);
    return promise;
}

function showContactModal() {
    const globalBtn = document.getElementById('cyberGlobalContactBtn');
    if (globalBtn) {
        globalBtn.click();
        return;
    }
    document.getElementById('contactModal').classList.add('show');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('show');
}

function saveSettings() {
    const showAnswer = document.getElementById('showAnswer')?.checked ?? true;
    const showOriginal = document.getElementById('showOriginal')?.checked ?? true;
    const questionTypes = getSelectedQuestionTypes();
    const questionTypeCounts = getQuestionTypeCounts();

    const settings = {
        showAnswer,
        showOriginal,
        questionTypes,
        questionTypeCounts
    };

    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function loadSettings() {
    const defaultTypes = getPracticeQuestionTypes().map((item) => item.label);
    const defaultCounts = normalizeQuestionTypeCounts({});

    const showAnswerEl = document.getElementById('showAnswer');
    if (showAnswerEl) showAnswerEl.checked = true;

    const showOriginalEl = document.getElementById('showOriginal');
    if (showOriginalEl) showOriginalEl.checked = true;

    const saved = localStorage.getItem(SETTINGS_KEY);
    if (!saved) {
        state.savedQuestionTypes = defaultTypes;
        state.savedQuestionTypeCounts = defaultCounts;
        return;
    }

    try {
        const parsed = JSON.parse(saved);
        if (showAnswerEl && parsed.showAnswer !== undefined) {
            showAnswerEl.checked = !!parsed.showAnswer;
        }
        if (showOriginalEl && parsed.showOriginal !== undefined) {
            showOriginalEl.checked = !!parsed.showOriginal;
        }

        if (Array.isArray(parsed.questionTypes) && parsed.questionTypes.length > 0) {
            const allowedSet = new Set(defaultTypes);
            const filtered = parsed.questionTypes
                .map((item) => String(item || '').trim())
                .filter((item) => allowedSet.has(item));
            state.savedQuestionTypes = filtered.length > 0 ? filtered : defaultTypes;
        } else {
            state.savedQuestionTypes = defaultTypes;
        }

        state.savedQuestionTypeCounts = normalizeQuestionTypeCounts(parsed.questionTypeCounts);
    } catch (e) {
        console.error('加载设置失败', e);
        state.savedQuestionTypes = defaultTypes;
        state.savedQuestionTypeCounts = defaultCounts;
    }
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

Object.assign(window, {
    handleWrongQuestionUpload,
    generateExam,
    composeExam,
    toggleQuestion,
    backToSelect,
    exportToPdf,
    exportToWord,
    closeModal,
    saveSettings,
    handleShowOriginalChange,
    openAuthModal,
    openRedeemModal,
    registerAccount,
    loginAccount,
    logoutAccount,
    redeemPoints
});
