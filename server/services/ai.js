// AI服务模块 - 使用 OpenAI SDK 兼容接口
const OpenAI = require('openai');
const fs = require('fs');
const nodePath = require('path');
const { AI_CONFIG } = require('../config/ai');
const { acquireAIKeyLease } = require('./ai-key-pool');

// ============================================================
// 质量约束常量 & 辅助函数（第一层 + 第五层）
// ============================================================

const QUALITY_CONSTRAINTS = `
【出题质量红线 — 违反任何一条则该题作废，必须重新出题】
1.【数值正确性】所有数值计算必须可逆向验证，answer 必须由题干数据经正确推导得出
2.【选项一致性】选择题 answer 必须是选项字母（如 A/B/C/D），explanation 推导结论必须指向该选项
3.【单位完整性】所有物理量必须附带正确单位，计算过程中单位必须参与运算并保持一致
4.【逻辑自洽性】题干条件不能自相矛盾，设问必须可由题干条件唯一确定答案
5.【科学准确性】所有定理、公式、常数、物理规律必须正确，不得违背基本科学原理
6.【数据一致性】题干中多处数据引用必须一致，不得出现前后数据矛盾
7.【图文匹配性】若题目含 figure 描述，figure 标注和数据必须与题干完全吻合
8.【文本规范性】不得出现乱码、残缺公式、未闭合括号、非法字符
9.【解析完整性】explanation 必须包含完整推导：解题思路→关键公式/定理→逐步推导→最终结论，每步有依据
10.【答案明确性】answer 必须是明确的最终答案，不能是模糊表述

【自检流程 — 生成每道题后必须执行】
- 用题干数据代入解析过程，验算是否能得到 answer
- 选择题：验证 answer 字母与 explanation 推导结论一致，干扰项合理（不能太荒谬也不能有歧义导致多选）
- 填空题：验证答案唯一且无歧义
- 检查所有数值的单位是否完整且一致
- 检查 figure 描述与题干数据是否吻合
- 检查 explanation 推导过程是否完整且结论与 answer 一致
`;

const ORIGINALITY_CONSTRAINTS = `
【原创性与教材约束】
- 每道题必须是原创的，不得直接照搬教材或真题
- 题目要有新意，避免套路化
- 题目之间不能重复考查同一个知识点的同一个角度
- 严格遵循指定教材版本的知识点体系和术语规范
`;

/**
 * 加载学科图形约束规范（第五层）
 */
const figureConstraintsCache = {};
function loadFigureConstraints(subject) {
  if (!subject) return '';
  if (figureConstraintsCache[subject]) return figureConstraintsCache[subject];
  try {
    const filePath = nodePath.join(__dirname, '../../docs/图形约束规范', `${subject}-图形约束规范.md`);
    const content = fs.readFileSync(filePath, 'utf-8');
    const trimmed = content.substring(0, 800);
    figureConstraintsCache[subject] = trimmed;
    return trimmed;
  } catch (e) {
    return '';
  }
}

function createAIClient(apiKey) {
  return new OpenAI({
    apiKey,
    baseURL: AI_CONFIG.baseURL
  });
}

function extractTextContent(content) {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || part.type !== 'text') return '';
      if (typeof part.text === 'string') return part.text;
      return part.text?.value || '';
    })
    .join('')
    .trim();
}

function buildUserMessageContent(userPrompt, options = {}) {
  const text = String(userPrompt || '').trim();
  const imageUrls = Array.isArray(options.imageUrls) ? options.imageUrls : [];

  if (!imageUrls.length) {
    return text;
  }

  const content = [];
  if (text) {
    content.push({ type: 'text', text });
  }

  for (const imageUrl of imageUrls) {
    if (!imageUrl || typeof imageUrl !== 'string') continue;
    content.push({
      type: 'image_url',
      image_url: { url: imageUrl }
    });
  }

  return content.length ? content : text;
}

/**
 * 调用 OpenAI SDK 生成内容（兼容图文输入）
 * @param {string} systemPrompt - 系统提示词
 * @param {string} userPrompt - 用户提示词
 * @param {object} options - 可选配置
 * @returns {Promise<string>} AI生成的文本内容
 */
async function generateContent(systemPrompt, userPrompt, options = {}) {
  const lease = acquireAIKeyLease();
  try {
    const aiClient = createAIClient(lease.apiKey);
    const model = options.model || AI_CONFIG.model;
    const completion = await aiClient.chat.completions.create({
      model,
      temperature: options.temperature ?? AI_CONFIG.temperature,
      max_tokens: options.maxTokens || AI_CONFIG.maxTokens,
      messages: [
        { role: 'system', content: String(systemPrompt || '') },
        { role: 'user', content: buildUserMessageContent(userPrompt, options) }
      ]
    });

    const text = extractTextContent(completion?.choices?.[0]?.message?.content);
    if (!text) {
      throw new Error('API返回空内容');
    }
    lease.release(true);
    return text;
  } catch (error) {
    lease.release(false, error);
    const status = error?.status || error?.response?.status;
    const reason = error?.error?.message || error?.message || '未知错误';
    if (status) {
      console.error(`AI API调用失败(key#${lease.index}): ${status} ${reason}`);
      throw new Error(`AI生成失败: API返回 ${status} - ${reason}`);
    }

    console.error(`AI API调用失败(key#${lease.index}):`, reason);
    throw new Error(`AI生成失败: ${reason}`);
  }
}

/**
 * 生成知识点建议
 * @param {object} params - 参数对象
 * @returns {Promise<Array<string>>} 知识点建议列表
 */
async function generateTopicSuggestions({ version, grade, subject, keyword, imageUrls = [] }) {
  const systemPrompt = `你是一位资深的${subject}教师，精通${version}教材体系。
你的任务是根据用户输入的关键词，生成相关的知识点建议。

要求：
1. 生成4-6个相关知识点
2. 知识点要符合${grade}的学习水平
3. 知识点要具体、可操作
4. 按照重要性排序
5. 直接返回知识点列表，每行一个，不要编号`;

  const userPrompt = `教材版本：${version}
年级：${grade}
科目：${subject}
关键词：${keyword}

请生成相关的知识点建议：`;

  const content = await generateContent(systemPrompt, userPrompt, { imageUrls });

  // 解析返回的知识点列表
  const topics = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.match(/^[\d\-\*\.]+/)) // 过滤空行和编号
    .slice(0, 6); // 最多6个

  return topics;
}

function parseJsonResponse(content, fallbackErrorMessage = 'AI返回格式不正确，请重试') {
  let jsonStr = String(content || '').trim();

  jsonStr = jsonStr
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '');

  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
  }

  // 修复字符串中的真实换行
  let fixed = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];

    if (escaped) {
      fixed += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      fixed += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      fixed += ch;
      inString = !inString;
      continue;
    }
    if (inString && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && jsonStr[i + 1] === '\n') i++;
      fixed += '\\n';
      continue;
    }
    fixed += ch;
  }

  jsonStr = fixed.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(jsonStr);
  } catch (e1) {
    // 修复单反斜杠非法转义
    let fixed2 = '';
    let inStr = false;
    let esc = false;

    for (let i = 0; i < jsonStr.length; i++) {
      const ch = jsonStr[i];

      if (esc) {
        if ('"\\/bfnrtu'.includes(ch) || (ch === 'u' && i + 4 < jsonStr.length)) {
          fixed2 += ch;
        } else {
          fixed2 += '\\' + ch;
        }
        esc = false;
        continue;
      }

      if (ch === '"' && (i === 0 || jsonStr[i - 1] !== '\\')) {
        inStr = !inStr;
        fixed2 += ch;
        continue;
      }
      if (ch === '\\' && inStr) {
        fixed2 += ch;
        esc = true;
        continue;
      }
      fixed2 += ch;
    }

    try {
      return JSON.parse(fixed2);
    } catch (e2) {
      console.error('JSON解析失败:', e2.message);
      console.error('原始内容前500字符:', String(content || '').substring(0, 500));
      throw new Error(fallbackErrorMessage);
    }
  }
}

function normalizeQuestionTypeLabel(typeLike) {
  const text = String(typeLike || '').toLowerCase();
  if (text.includes('相似') || text.includes('similar')) return 'similar';
  if (text.includes('变式') || text.includes('variant')) return 'variant';
  if (text.includes('综合应用') || text.includes('application')) return 'application';
  if (text.includes('choice') || text.includes('选择')) return 'choice';
  if (text.includes('fill') || text.includes('blank') || text.includes('填空')) return 'blank';
  if (text.includes('qa') || text.includes('calculation') || text.includes('解答') || text.includes('计算')) return 'qa';
  return 'other';
}

function ensureAnswersFromQuestions(exam, options = {}) {
  const force = Boolean(options.force);
  if (!force && Array.isArray(exam.answers) && exam.answers.length > 0) return;
  const answers = [];
  if (!Array.isArray(exam.questions)) {
    exam.answers = answers;
    return;
  }

  for (const group of exam.questions) {
    if (!Array.isArray(group?.items)) continue;
    for (const item of group.items) {
      if (!item) continue;
      const idx = item.index || answers.length + 1;
      const answer = item.answer ? String(item.answer).trim() : '略';
      const explanation = item.explanation ? String(item.explanation).trim() : '';
      answers.push(`${idx}. ${answer}${explanation ? ` 解析：${explanation}` : ''}`);
    }
  }
  exam.answers = answers;
}

function enforceFigureMode(exam, hasFigure) {
  if (!exam.questions || !Array.isArray(exam.questions)) return;

  for (const group of exam.questions) {
    if (!group.items || !Array.isArray(group.items)) continue;
    for (const item of group.items) {
      if (!item) continue;

      if (!hasFigure) {
        item.figure = null;
        continue;
      }

      if (!item.figure) {
        item.figure = {
          type: 'diagram',
          description: `根据题干“${String(item.stem || '').slice(0, 60)}”绘制清晰示意图，包含关键已知量、标注与关系。`
        };
        continue;
      }

      if (typeof item.figure === 'string') {
        const desc = item.figure.trim();
        item.figure = {
          type: 'diagram',
          description: desc || `根据题干“${String(item.stem || '').slice(0, 60)}”绘制示意图。`
        };
        continue;
      }

      if (typeof item.figure === 'object') {
        if (!item.figure.type) item.figure.type = 'diagram';
        if (!item.figure.description || !String(item.figure.description).trim()) {
          item.figure.description = `根据题干“${String(item.stem || '').slice(0, 60)}”绘制示意图。`;
        }
      }
    }
  }
}

function extractCircuitLabelTokens(text) {
  const normalized = String(text || '').toUpperCase();
  const matches = normalized.match(/\b(?:S\d+|R\d+|L\d+|S|R|L)\b/g) || [];
  const unique = Array.from(new Set(matches));
  const hasSpecific = unique.some((token) => /\d/.test(token));
  return hasSpecific
    ? unique.filter((token) => /\d/.test(token))
    : unique.filter((token) => token === 'S' || token === 'R' || token === 'L');
}

function isCircuitLikeText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  if (/(电路|开关|电阻|灯泡|串联|并联|欧姆|Ω|电压|电流|伏特|安培)/.test(raw)) return true;
  return extractCircuitLabelTokens(raw).length > 0;
}

function getFigureDescription(figure) {
  if (!figure) return '';
  if (typeof figure === 'string') return figure.trim();
  if (typeof figure === 'object') return String(figure.description || '').trim();
  return '';
}

function findCircuitFigureTokenMismatch(stem, figureDescription) {
  const stemTokens = extractCircuitLabelTokens(stem);
  const figureTokens = extractCircuitLabelTokens(figureDescription);
  const missingInFigure = stemTokens.filter((token) => !figureTokens.includes(token));
  const extraInFigure = figureTokens.filter((token) => !stemTokens.includes(token));
  return { stemTokens, figureTokens, missingInFigure, extraInFigure };
}

function buildStrictFigureDescription(stem, originalDescription = '') {
  const stemText = String(stem || '').trim();
  const extra = String(originalDescription || '').trim();
  return [
    '请严格依据题干绘制示意图，元件名称、编号、数量、连接关系与题干完全一致，不得增删或替换。',
    `题干：${stemText}`,
    extra ? `补充要求：${extra}` : ''
  ].filter(Boolean).join('\n');
}

function enforceFigureTextConsistency(exam) {
  if (!exam?.questions || !Array.isArray(exam.questions)) return;

  for (const group of exam.questions) {
    if (!Array.isArray(group?.items)) continue;

    for (const item of group.items) {
      if (!item?.figure) continue;

      const stem = String(item.stem || '').trim();
      if (!stem) continue;

      if (typeof item.figure === 'string') {
        item.figure = { type: 'diagram', description: item.figure.trim() };
      } else if (typeof item.figure !== 'object') {
        item.figure = { type: 'diagram', description: '' };
      }
      if (!item.figure.type) item.figure.type = 'diagram';

      const currentDescription = getFigureDescription(item.figure);
      const isCircuit = isCircuitLikeText(stem) || isCircuitLikeText(currentDescription);
      if (!isCircuit) continue;

      const mismatch = findCircuitFigureTokenMismatch(stem, currentDescription);
      if (!mismatch.missingInFigure.length && !mismatch.extraInFigure.length) continue;

      item.figure.description = buildStrictFigureDescription(stem, currentDescription);
      console.log(
        `[图文一致] 题${item.index || '?'} 检测到标签不一致，已重写figure描述（缺失:${mismatch.missingInFigure.join('/') || '无'}；多余:${mismatch.extraInFigure.join('/') || '无'}）`
      );
    }
  }
}

function normalizeElectricalUnitsAndFormulas(exam, subjectHint = '') {
  if (!exam?.questions || !Array.isArray(exam.questions)) return;

  const isPhysicsSubject = /(物理|physics)/i.test(String(subjectHint || ''));
  const electricalKeywords = /(电路|开关|电阻|阻值|欧姆|Ω|串联|并联|电流|电压|功率|灯泡|伏特|安培|瓦特|R\d|S\d|P额|U额|I[_\s]?L)/i;

  const collectSample = [];
  for (const group of exam.questions) {
    if (group?.title) collectSample.push(String(group.title));
    if (!Array.isArray(group?.items)) continue;
    for (const item of group.items) {
      if (!item) continue;
      if (item.stem) collectSample.push(String(item.stem));
      if (item.explanation) collectSample.push(String(item.explanation));
      if (Array.isArray(item.options)) {
        for (const opt of item.options) {
          if (opt) collectSample.push(String(opt));
        }
      }
    }
  }

  const joinedSample = collectSample.join('\n');
  if (!isPhysicsSubject && !electricalKeywords.test(joinedSample)) {
    return;
  }

  const normalizeResistanceValue = (numText) => {
    const raw = String(numText || '').trim();
    if (!raw) return raw;
    if (raw.includes('.')) return `${raw}Ω`;
    if (/^\d{2,}$/.test(raw) && /[02]$/.test(raw)) {
      const trimmed = raw.slice(0, -1);
      if (trimmed) return `${trimmed}Ω`;
    }
    return `${raw}Ω`;
  };

  const normalizeText = (input) => {
    if (typeof input !== 'string' || !input.trim()) return input;
    let r = input;

    r = r.replace(/[Ωω]/g, 'Ω');
    r = r.replace(/(\d+(?:\.\d+)?)\s*(?:欧姆|ohm)\b/gi, '$1Ω');
    r = r.replace(/\bI[_\s]?L\s*P额\s*\/\s*U额\b/g, 'I_L = P额 / U额');
    r = r.replace(/\bI[_\s]?L\s*=\s*P额\s*\/\s*U额\b/g, 'I_L = P额 / U额');

    r = r.replace(/(R\d+\s*=\s*[^=\n]{0,80}=\s*)(\d+(?:\.\d+)?)(?!\s*(?:Ω|欧姆|ohm|[a-zA-Z]))/gi, (m, p1, p2) => `${p1}${normalizeResistanceValue(p2)}`);
    r = r.replace(/(R\d+\s*=\s*)(\d+(?:\.\d+)?)(?!\s*(?:Ω|欧姆|ohm|[a-zA-Z]))/gi, (m, p1, p2) => `${p1}${normalizeResistanceValue(p2)}`);
    r = r.replace(/((?:总)?电阻(?:值)?(?:为|是)?\s*)(\d+(?:\.\d+)?)(?!\s*(?:Ω|欧姆|ohm|[a-zA-Z]))/g, (m, p1, p2) => `${p1}${normalizeResistanceValue(p2)}`);
    r = r.replace(/(阻值(?:为|是)?\s*)(\d+(?:\.\d+)?)(?!\s*(?:Ω|欧姆|ohm|[a-zA-Z]))/g, (m, p1, p2) => `${p1}${normalizeResistanceValue(p2)}`);

    if (/(功率|电功率|额定功率|\bP(?:额|总|实)?\b)/.test(r)) {
      r = r.replace(/(\bP(?:额|总|实)?\s*=\s*)(\d+(?:\.\d+)?)\s*(?:N|%)(?=[^\w]|$)/g, '$1$2W');
      r = r.replace(/(功率[^。；\n]{0,20}(?:为|是|=)\s*)(\d+(?:\.\d+)?)\s*(?:N|%)(?=[^\w]|$)/g, '$1$2W');
    }

    r = r.replace(/\s{2,}/g, ' ').trim();
    return r;
  };

  for (const group of exam.questions) {
    if (group?.title) group.title = normalizeText(group.title);
    if (!Array.isArray(group?.items)) continue;
    for (const item of group.items) {
      if (!item) continue;
      if (item.stem) item.stem = normalizeText(item.stem);
      if (item.answer) item.answer = normalizeText(String(item.answer));
      if (item.explanation) item.explanation = normalizeText(String(item.explanation));
      if (Array.isArray(item.options)) {
        item.options = item.options.map((opt) => normalizeText(String(opt || '')));
      }
      if (item.figure && typeof item.figure === 'object' && item.figure.description) {
        item.figure.description = normalizeText(String(item.figure.description));
      }
    }
  }

  if (Array.isArray(exam.answers)) {
    exam.answers = exam.answers.map((ans) => normalizeText(String(ans || '')));
  }
}

/**
 * 生成试卷
 * @param {object} params - 试卷参数
 * @returns {Promise<object>} 试卷对象
 */
async function generateExam(params) {
  const {
    version = '人教版',
    grade = '',
    subject = '',
    topics = '',
    examPoints = '',
    difficulty = 5,
    questionCount = 12,
    questionTypes = '选择题、填空题、解答题',
    difficultyPrompt = '',
    imageUrls = []
  } = params;

  const topicsText = Array.isArray(topics) ? topics.join('、') : String(topics || '');
  const examPointsText = Array.isArray(examPoints) ? examPoints.join('、') : String(examPoints || '');

  const figureConstraints = loadFigureConstraints(subject);
  const figureConstraintSection = figureConstraints
    ? `\n【${subject}学科图形约束规范】\n${figureConstraints}\n`
    : '';

  const systemPrompt = `你是一位拥有20年教学经验的资深${subject}教师，精通${version || '各版本'}教材体系，请生成高质量中文试卷。

要求：
1. 严格输出 JSON，禁止 markdown 包裹
2. 题目有梯度，由易到难
3. 每题必须提供 answer 与 explanation
4. 禁止使用 LaTeX，使用纯文本与 Unicode 符号（如 ²、√、π、≤、≥ 等）
5. 如果题目需要图形，可使用 figure 字段描述图形，禁止使用"如图所示"等模糊表述
${QUALITY_CONSTRAINTS}${ORIGINALITY_CONSTRAINTS}${figureConstraintSection}`;

  const userPrompt = `请生成试卷：
教材版本：${version}
年级：${grade}
科目：${subject}
知识点：${topicsText}
考点：${examPointsText}
难度：${difficulty}/10
题量：${questionCount}
题型：${questionTypes}
难度说明：${difficultyPrompt || '无'}

输出格式（严格遵守）：
{
  "title": "试卷标题",
  "questions": [
    {
      "type": "choice|blank|qa",
      "title": "分组标题",
      "items": [
        {
          "index": 1,
          "stem": "题干（完整、清晰、无歧义）",
          "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
          "answer": "A（选择题填选项字母；填空题填答案；解答题填最终结果）",
          "explanation": "解题思路→关键公式→逐步推导→最终结论",
          "figure": { "type": "diagram", "description": "图形描述" }
        }
      ]
    }
  ],
  "answers": [
    "1. 答案 解析：..."
  ]
}`;

  const content = await generateContent(systemPrompt, userPrompt, {
    maxTokens: 8000,
    temperature: 0.3,
    imageUrls
  });

  const exam = parseJsonResponse(content, 'AI返回的试卷格式不正确，请重试');
  if (!exam.questions || !Array.isArray(exam.questions) || exam.questions.length === 0) {
    throw new Error('AI未生成有效题目，请重试');
  }

  postProcessFigures(exam);
  postProcessLatexSymbols(exam);
  normalizeElectricalUnitsAndFormulas(exam, subject);
  ensureAnswersFromQuestions(exam, { force: true });

  // 第三层：AI 二次审校
  await reviewExamQuestions(exam);
  enforceFigureTextConsistency(exam);
  normalizeElectricalUnitsAndFormulas(exam, subject);
  ensureAnswersFromQuestions(exam, { force: true });

  // 第四层：结构化硬规则校验 + 自动修复
  const { validateExam } = require('./validator');
  const validation = validateExam(exam);
  if (validation.fixedItems.length > 0) {
    console.log(`[校验] 自动修复: ${validation.fixedItems.join('; ')}`);
    ensureAnswersFromQuestions(exam, { force: true }); // 修复后重建 answers
  }
  if (validation.errors.length > 0) {
    console.warn(`[校验] 发现结构问题: ${validation.errors.join('; ')}`);
  }
  if (validation.warnings.length > 0) {
    console.warn(`[校验] 警告: ${validation.warnings.join('; ')}`);
  }
  const criticalFigureErrors = validation.errors.filter((msg) => msg.includes('图文一致性失败'));
  if (criticalFigureErrors.length > 0) {
    throw new Error(`图文一致性校验未通过：${criticalFigureErrors.join('；')}`);
  }

  exam.metadata = {
    version,
    grade,
    subject,
    topics: topicsText,
    examPoints: examPointsText,
    difficulty,
    generatedAt: new Date().toISOString()
  };

  return exam;
}

/**
 * 解析上传的错题，提取知识点、考点、答案解析、是否含图
 */
async function analyzeWrongQuestion({
  fileName = '',
  mimeType = '',
  previewImageUrl = '',
  extractedText = ''
}) {
  const systemPrompt = `你是一位资深中小学教研老师，擅长错题诊断与知识点拆解。
请严格输出 JSON，不要输出任何额外文字。
若识别为英语学科（尤其完形填空、阅读理解、七选五等语篇题），必须按“整题”分析：
1. 优先识别完整语篇 + 全部小问，不得只围绕单个小问给出结论；
2. 当图片疑似只截取了小问、上下文不足时，needsWholeQuestion 返回 true，并给出 wholeQuestionAdvice。`;

  const userPrompt = `请分析这道学生错题，并返回结构化结果。

输入信息：
- 文件名：${fileName || '未提供'}
- 文件类型：${mimeType || '未知'}
- OCR文本（可能不完整）：${String(extractedText || '').slice(0, 2000) || '无'}

输出要求（严格JSON）：
{
  "subject": "科目（如数学/物理/英语，无法判断可写空字符串）",
  "grade": "年级（无法判断可写空字符串）",
  "knowledgePoints": ["知识点1", "知识点2"],
  "examPoints": ["考点1", "考点2"],
  "answerAnalysis": "这道题的核心解题思路与答案解析，80~220字",
  "hasFigure": true,
  "originalQuestionText": "对原题题干的尽量准确转写",
  "needsWholeQuestion": false,
  "wholeQuestionAdvice": "当英语题上下文不足时给出提示，否则为空字符串"
}

约束：
1. knowledgePoints 与 examPoints 均返回 2~6 条，避免空数组
2. hasFigure 只返回 true 或 false
3. originalQuestionText 尽量完整，如果看不清可按可见内容输出
4. 若 subject=英语 且语篇上下文不足，needsWholeQuestion=true，wholeQuestionAdvice 给出“请上传包含完整文章与全部小问的一整题”类型提示
5. 其他情况 needsWholeQuestion=false，wholeQuestionAdvice 返回空字符串`;

  const content = await generateContent(systemPrompt, userPrompt, {
    maxTokens: 2200,
    temperature: 0.2,
    imageUrls: previewImageUrl ? [previewImageUrl] : []
  });

  const parsed = parseJsonResponse(content, 'AI返回的错题解析格式不正确，请重试');

  const normalizeList = (value) => {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 8);
  };

  const cleanMathText = (text) => {
    let r = String(text || '');
    if (!r) return '';

    r = r.replace(/\$\$(.*?)\$\$/gs, '$1');
    r = r.replace(/\$(.*?)\$/gs, '$1');
    r = r.replace(/\\\$/g, '$');
    r = r.replace(/\$/g, '');
    r = r.replace(/\\dfrac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)');
    r = r.replace(/\\tfrac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)');
    r = r.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)');
    r = r.replace(/\\sqrt\{([^{}]*)\}/g, '√($1)');
    r = r.replace(/\\sqrt\[(\d+)\]\{([^{}]*)\}/g, '$1√($2)');
    r = r.replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\{([^{}]*)\}/g, '$1');
    r = r.replace(/\\(?:overline|underline)\{([^{}]*)\}/g, '$1');
    r = r.replace(/\\(?:vec|overrightarrow)\{([^{}]*)\}/g, '→$1');

    const symbolMap = {
      '\\triangle': '△',
      '\\angle': '∠',
      '\\circ': '°',
      '\\times': '×',
      '\\div': '÷',
      '\\cdot': '·',
      '\\leq': '≤',
      '\\geq': '≥',
      '\\neq': '≠',
      '\\approx': '≈',
      '\\parallel': '∥',
      '\\perp': '⊥',
      '\\alpha': 'α',
      '\\beta': 'β',
      '\\gamma': 'γ',
      '\\delta': 'δ',
      '\\theta': 'θ',
      '\\lambda': 'λ',
      '\\mu': 'μ',
      '\\pi': 'π',
      '\\sigma': 'σ',
      '\\phi': 'φ',
      '\\omega': 'ω',
      '\\Delta': 'Δ',
      '\\Omega': 'Ω',
      '\\rightarrow': '→',
      '\\leftarrow': '←',
      '\\to': '→',
      '\\infty': '∞',
      '\\sin': 'sin',
      '\\cos': 'cos',
      '\\tan': 'tan',
      '\\log': 'log',
      '\\ln': 'ln',
      '\\left': '',
      '\\right': ''
    };

    for (const [latex, plain] of Object.entries(symbolMap)) {
      const escaped = latex.replace(/\\/g, '\\\\');
      r = r.replace(new RegExp(escaped, 'g'), plain);
    }

    r = r.replace(/\^\{([^{}]*)\}/g, '^($1)');
    r = r.replace(/_\{([^{}]*)\}/g, '_($1)');
    // 仅移除命令前导反斜杠，避免误删普通字母（如 \A 误删为 ''）
    r = r.replace(/\\([a-zA-Z]+)(?=\s|[{}()[\],.;:!?+\-*/=<>]|$)/g, '$1');
    r = r.replace(/\\([{}$%&_#])/g, '$1');
    r = r.replace(/\\/g, '');
    r = r.replace(/[{}]/g, '');
    r = r.replace(/\s{2,}/g, ' ').trim();
    return r;
  };

  return {
    subject: cleanMathText(parsed.subject),
    grade: cleanMathText(parsed.grade),
    knowledgePoints: normalizeList(parsed.knowledgePoints).map((item) => cleanMathText(item)),
    examPoints: normalizeList(parsed.examPoints).map((item) => cleanMathText(item)),
    answerAnalysis: cleanMathText(parsed.answerAnalysis),
    hasFigure: Boolean(parsed.hasFigure),
    originalQuestionText: cleanMathText(parsed.originalQuestionText),
    needsWholeQuestion: Boolean(parsed.needsWholeQuestion),
    wholeQuestionAdvice: cleanMathText(parsed.wholeQuestionAdvice)
  };
}

/**
 * 基于错题解析结果生成专练题
 */
async function generateWrongQuestionPractice(params) {
  const {
    subject = '',
    grade = '',
    knowledgePoints = [],
    examPoints = [],
    answerAnalysis = '',
    sourceQuestionText = '',
    hasFigure = false,
    questionTypes = ['相似题', '变式题', '综合应用题'],
    questionTypeCounts = {},
    questionCount = 3,
    imageUrls = []
  } = params;

  const titleMap = {
    similar: '相似题',
    variant: '变式题',
    application: '综合应用题'
  };
  const defaultTypeCounts = {
    similar: 1,
    variant: 1,
    application: 1
  };
  const clampTypeCount = (value) => {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) return 1;
    return Math.min(5, Math.max(1, parsed));
  };

  const normalizedTypes = Array.isArray(questionTypes) && questionTypes.length > 0
    ? questionTypes.map((item) => String(item || '').trim()).filter(Boolean)
    : ['相似题', '变式题', '综合应用题'];

  const selectedOrder = Array.from(new Set(
    normalizedTypes
      .map((type) => normalizeQuestionTypeLabel(type))
      .filter((key) => ['similar', 'variant', 'application'].includes(key))
  ));
  const finalOrder = selectedOrder.length ? selectedOrder : ['similar', 'variant', 'application'];

  const normalizedTypeCountMap = {};
  for (const key of Object.keys(defaultTypeCounts)) {
    normalizedTypeCountMap[key] = clampTypeCount(questionTypeCounts?.[key] ?? defaultTypeCounts[key]);
  }

  const selectedTypeCountMap = {};
  for (const key of finalOrder) {
    selectedTypeCountMap[key] = normalizedTypeCountMap[key] || defaultTypeCounts[key];
  }

  const totalCount = Math.max(
    1,
    parseInt(questionCount, 10)
    || finalOrder.reduce((sum, key) => sum + selectedTypeCountMap[key], 0)
    || 3
  );

  const figureConstraints = loadFigureConstraints(subject);
  const figureConstraintSection = figureConstraints
    ? `\n【${subject}学科图形约束规范】\n${figureConstraints}\n`
    : '';

  const systemPrompt = `你是一位拥有20年教学经验的资深${subject || ''}教师，专门根据学生错题生成定制化专练题。
你的输出必须是 JSON，禁止 markdown 包裹。

出题规则：
1. 只围绕给定知识点与考点出题
2. 题型仅使用用户选择的题型
3. 相似题：同考点、同类型，但不能只是改数字，需要改变情境和条件设置
4. 变式题：同考点，不同题型，明显区别于相似题，考查角度要有变化
5. 综合应用题：同考点，结合真实生活场景，考查知识的迁移应用能力
6. 每道题都要有 answer 与 explanation 字段
7. 禁止 LaTeX，使用纯文本与 Unicode 符号（如 ²、√、π、≤、≥ 等）
8. 如果 hasFigure=true，则每一题都必须包含 figure；如果 hasFigure=false，则所有题目不包含 figure
9. 若题目含电路图，题干、解析、figure.description 的元件标签与参数必须完全一致（例如 S/S1/S2、R1/R2），禁止套用模板残留
${QUALITY_CONSTRAINTS}${ORIGINALITY_CONSTRAINTS}${figureConstraintSection}`;

  const userPrompt = `请基于以下错题信息生成专练题：

科目：${subject || '未指定'}
年级：${grade || '未指定'}
知识点：${knowledgePoints.join('、') || '未指定'}
考点：${examPoints.join('、') || '未指定'}
原题题干：${sourceQuestionText || '未提供'}
原题解析：${answerAnalysis || '未提供'}
图形约束：${hasFigure ? '每题必须有图形' : '每题不需要图形'}
题型选择：${normalizedTypes.join('、')}
各题型数量：${finalOrder.map((key) => `${titleMap[key]}${selectedTypeCountMap[key]}道`).join('，')}
总题量：${totalCount}

输出 JSON 格式（严格遵守）：
{
  "title": "错题啄木鸟-定制练习",
  "questions": [
    {
      "type": "similar | variant | application",
      "title": "分组标题",
      "items": [
        {
          "index": 1,
          "stem": "题干（完整、清晰、无歧义）",
          "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
          "answer": "A（选择题填选项字母；填空题填答案；解答题填最终结果）",
          "explanation": "解题思路→关键公式→逐步推导→最终结论",
          "figure": { "type": "diagram", "description": "图形描述" }
        }
      ]
    }
  ],
  "answers": [
    "1. 答案 解析：..."
  ]
}`;

  const content = await generateContent(systemPrompt, userPrompt, {
    maxTokens: 8000,
    temperature: 0.3,
    imageUrls
  });

  const exam = parseJsonResponse(content, 'AI返回的试卷格式不正确，请重试');
  if (!exam.questions || !Array.isArray(exam.questions) || exam.questions.length === 0) {
    throw new Error('AI未生成有效题目，请重试');
  }

  const grouped = {};
  let fallbackGroupKey = normalizeQuestionTypeLabel(normalizedTypes[0] || '相似题');
  if (!['similar', 'variant', 'application'].includes(fallbackGroupKey)) {
    fallbackGroupKey = 'similar';
  }

  for (const group of exam.questions) {
    if (!Array.isArray(group?.items) || group.items.length === 0) continue;
    const key = normalizeQuestionTypeLabel(group.type || group.title) || fallbackGroupKey;
    const finalKey = ['similar', 'variant', 'application'].includes(key) ? key : fallbackGroupKey;
    if (!grouped[finalKey]) grouped[finalKey] = [];
    grouped[finalKey].push(...group.items.filter(Boolean));
  }

  const normalizedQuestions = [];
  let globalIndex = 1;
  for (const key of finalOrder) {
    const targetCount = selectedTypeCountMap[key] || 0;
    if (targetCount <= 0) continue;

    const sourceItems = grouped[key] || [];
    const items = sourceItems.slice(0, targetCount);
    if (items.length < targetCount) {
      throw new Error(`${titleMap[key]}数量不足，请重试`);
    }

    normalizedQuestions.push({
      type: key,
      title: titleMap[key],
      items: items.map((item) => ({ ...item, index: globalIndex++ }))
    });
  }

  if (normalizedQuestions.length === 0) {
    throw new Error('AI未生成有效题目，请重试');
  }

  exam.questions = normalizedQuestions;
  postProcessFigures(exam);
  postProcessLatexSymbols(exam);
  normalizeElectricalUnitsAndFormulas(exam, subject);
  enforceFigureMode(exam, hasFigure);
  ensureAnswersFromQuestions(exam, { force: true });

  // 第三层：AI 二次审校
  await reviewExamQuestions(exam);
  enforceFigureTextConsistency(exam);
  normalizeElectricalUnitsAndFormulas(exam, subject);
  ensureAnswersFromQuestions(exam, { force: true });

  // 第四层：结构化硬规则校验 + 自动修复
  const { validateExam } = require('./validator');
  const validation = validateExam(exam);
  if (validation.fixedItems.length > 0) {
    console.log(`[校验] 自动修复: ${validation.fixedItems.join('; ')}`);
    ensureAnswersFromQuestions(exam, { force: true });
  }
  if (validation.errors.length > 0) {
    console.warn(`[校验] 发现结构问题: ${validation.errors.join('; ')}`);
  }
  if (validation.warnings.length > 0) {
    console.warn(`[校验] 警告: ${validation.warnings.join('; ')}`);
  }
  const criticalFigureErrors = validation.errors.filter((msg) => msg.includes('图文一致性失败'));
  if (criticalFigureErrors.length > 0) {
    throw new Error(`图文一致性校验未通过：${criticalFigureErrors.join('；')}`);
  }

  exam.metadata = {
    subject,
    grade,
    knowledgePoints,
    examPoints,
    questionTypeCounts: selectedTypeCountMap,
    hasFigure,
    generatedAt: new Date().toISOString(),
    source: 'wrong-question-practice'
  };

  return exam;
}

// ============================================================
// 第三层：AI 二次审校（Review Chain）
// ============================================================

/**
 * 对生成的试卷进行 AI 独立审校，逐题验算答案正确性
 * 审校未通过的题目会自动修正
 */
async function reviewExamQuestions(exam) {
  const allItems = [];
  for (const group of exam.questions) {
    if (!Array.isArray(group?.items)) continue;
    for (const item of group.items) {
      if (item) allItems.push(item);
    }
  }
  if (allItems.length === 0) return;

  const questionsForReview = allItems.map((item) => {
    const q = { index: item.index, stem: item.stem, answer: item.answer, explanation: item.explanation };
    if (item.options) q.options = item.options;
    if (item.figure) q.figure = item.figure;
    return q;
  });

  const reviewSystemPrompt = `你是一位严格的教研审核员，负责逐题审校试卷的准确性。
对每道题你必须：
1. 根据题干条件独立求解，得出你认为的正确答案
2. 将你的答案与给出的 answer 对比
3. 检查 explanation 的推导是否正确、完整
4. 检查是否有科学性错误、单位遗漏、数据矛盾、逻辑漏洞
5. 选择题：检查 answer 是否为正确的选项字母，干扰项是否合理
6. 填空题/解答题：检查答案是否唯一且正确
7. 若题目包含 figure，必须核对题干、explanation、figure.description 三者中的元件标签与参数是否一致（例如 S/S1/S2、R1/R2）

严格输出 JSON，不要输出任何额外文字。禁止使用 LaTeX，使用纯文本与 Unicode 符号。`;

  const reviewUserPrompt = `请审校以下 ${allItems.length} 道题目：

${JSON.stringify(questionsForReview, null, 2)}

对每道题返回审校结果，输出格式：
{
  "reviews": [
    {
      "index": 题号,
      "passed": true或false,
      "myAnswer": "你独立求解得到的答案",
      "issues": ["发现的问题1", "问题2"],
      "correctedStem": "修正后的题干（仅当需要修正时）",
      "correctedOptions": ["修正后的选项（仅当需要修正时）"],
      "correctedAnswer": "修正后的答案（仅当需要修正时）",
      "correctedExplanation": "修正后的解析（仅当需要修正时）",
      "correctedFigureDescription": "修正后的 figure.description（仅当需要修正时）"
    }
  ]
}

注意：
- passed=true 表示该题完全正确，不需要提供修正字段
- passed=false 表示该题有问题，必须提供修正后的相应字段
- 若图文不一致，必须提供 correctedFigureDescription，且与 correctedStem / correctedExplanation 保持一致
- 只需提供需要修正的字段`;

  try {
    console.log(`[审校] 开始审校 ${allItems.length} 道题...`);
    const content = await generateContent(reviewSystemPrompt, reviewUserPrompt, {
      temperature: 0.1,
      maxTokens: 6000
    });

    const result = parseJsonResponse(content, '审校结果格式不正确');
    if (!result.reviews || !Array.isArray(result.reviews)) {
      console.warn('[审校] 审校返回格式异常，跳过');
      return;
    }

    let correctedCount = 0;
    for (const review of result.reviews) {
      if (review.passed) continue;

      const targetItem = allItems.find(item => item.index === review.index);
      if (!targetItem) continue;

      if (review.correctedStem) targetItem.stem = review.correctedStem;
      if (review.correctedOptions && Array.isArray(review.correctedOptions)) {
        targetItem.options = review.correctedOptions;
      }
      if (review.correctedAnswer) targetItem.answer = review.correctedAnswer;
      if (review.correctedExplanation) targetItem.explanation = review.correctedExplanation;
      if (review.correctedFigureDescription && String(review.correctedFigureDescription).trim()) {
        const nextDescription = String(review.correctedFigureDescription).trim();
        if (!targetItem.figure || typeof targetItem.figure !== 'object') {
          targetItem.figure = { type: 'diagram', description: nextDescription };
        } else {
          targetItem.figure.description = nextDescription;
          if (!targetItem.figure.type) targetItem.figure.type = 'diagram';
        }
      }

      correctedCount++;
      console.log(`[审校] 题${review.index} 已修正: ${(review.issues || []).join('; ')}`);
    }

    if (correctedCount > 0) {
      console.log(`[审校] 共修正 ${correctedCount}/${allItems.length} 道题`);
      // 审校修正后重建 answers
      ensureAnswersFromQuestions(exam, { force: true });
    } else {
      console.log('[审校] 所有题目审校通过');
    }
  } catch (error) {
    console.error('[审校] 审校过程出错，跳过审校:', error.message);
  }
}

/**
 * 后处理：智能图形一致性检查
 * 1. 题干含"如图"但没有figure → 移除"如图"相关字样
 * 2. figure字段存在但description为空 → 移除figure
 * 3. figure是纯文字提示词而非结构化对象 → 规范化
 */
function postProcessFigures(exam) {
  if (!exam.questions || !Array.isArray(exam.questions)) return;

  // 匹配题干中"如图"相关字样的正则
  const figureRefPattern = /如图[所示]*[，,]?|[如见]下图[所示]*[，,]?|图中[所示]*[，,]?|由图[可知]*[，,]?/g;

  for (const group of exam.questions) {
    if (!group.items || !Array.isArray(group.items)) continue;

    for (const item of group.items) {
      if (!item || !item.stem) continue;

      const hasFigureRef = figureRefPattern.test(item.stem);
      figureRefPattern.lastIndex = 0; // 重置正则

      const hasFigure = item.figure &&
        (typeof item.figure === 'string' ? item.figure.trim() : item.figure.description?.trim());

      if (hasFigureRef && !hasFigure) {
        // 题干提到"如图"但没有有效的figure → 移除"如图"字样
        item.stem = item.stem.replace(figureRefPattern, '');
        item.stem = item.stem.replace(/^\s*[，,]\s*/, '').trim();
        item.figure = null;
        console.log(`[后处理] 题${item.index}: 移除了无图的"如图"引用`);
      }

      if (item.figure) {
        // 规范化figure字段
        if (typeof item.figure === 'string') {
          const desc = item.figure.trim();
          if (!desc) {
            item.figure = null;
          } else {
            item.figure = { type: 'diagram', description: desc };
          }
        } else if (typeof item.figure === 'object') {
          if (!item.figure.description || !item.figure.description.trim()) {
            item.figure = null;
          }
        }
      }
    }
  }
}

/**
 * 后处理：将残留的LaTeX符号和公式转换为纯文本Unicode
 */
function postProcessLatexSymbols(exam) {
  if (!exam.questions || !Array.isArray(exam.questions)) return;

  function cleanLatex(text) {
    if (!text || typeof text !== 'string') return text;

    let r = text;

    // 1. 移除 $ 包裹
    r = r.replace(/\$\$(.*?)\$\$/g, '$1');
    r = r.replace(/\$(.*?)\$/g, '$1');

    // 2. 处理LaTeX公式命令（从复杂到简单）
    r = r.replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)');
    r = r.replace(/\\frac\(([^)]*)\)\(([^)]*)\)/g, '($1)/($2)');
    r = r.replace(/\\sqrt\[(\d+)\]\{([^}]*)\}/g, '$1√($2)');
    r = r.replace(/\\sqrt\{([^}]*)\}/g, '√($1)');
    r = r.replace(/\\overrightarrow\{([^}]*)\}/g, '→$1');
    r = r.replace(/\\vec\{([^}]*)\}/g, '→$1');
    r = r.replace(/\\overline\{([^}]*)\}/g, '$1');
    r = r.replace(/\\underline\{([^}]*)\}/g, '$1');
    r = r.replace(/\\mathbb\{([^}]*)\}/g, '$1');
    r = r.replace(/\\mathrm\{([^}]*)\}/g, '$1');
    r = r.replace(/\\text\{([^}]*)\}/g, '$1');
    r = r.replace(/\\lim_\{([^}]*)\}/g, 'lim($1)');
    r = r.replace(/\\sum_\{([^}]*)\}\^\{([^}]*)\}/g, 'Σ($1到$2)');
    r = r.replace(/\\int_\{([^}]*)\}\^\{([^}]*)\}/g, '∫($1到$2)');
    r = r.replace(/\\log_\{([^}]*)\}/g, 'log$1');

    // 3. 上下标
    r = r.replace(/\^\{([^}]*)\}/g, (_, p) => toSuperscript(p));
    r = r.replace(/_\{([^}]*)\}/g, (_, p) => toSubscript(p));
    r = r.replace(/\^(\d)/g, (_, d) => toSuperscript(d));
    r = r.replace(/_(\d)/g, (_, d) => toSubscript(d));

    // 4. 单个LaTeX符号替换
    const symbolMap = {
      '\\angle': '∠', '\\triangle': '△', '\\circ': '°', '\\degree': '°',
      '\\parallel': '∥', '\\perp': '⊥', '\\cong': '≅', '\\sim': '∽', '\\square': '□',
      '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ', '\\epsilon': 'ε',
      '\\theta': 'θ', '\\lambda': 'λ', '\\mu': 'μ', '\\pi': 'π', '\\sigma': 'σ',
      '\\phi': 'φ', '\\omega': 'ω', '\\Delta': 'Δ', '\\Omega': 'Ω', '\\rho': 'ρ',
      '\\eta': 'η', '\\zeta': 'ζ', '\\xi': 'ξ', '\\tau': 'τ', '\\Sigma': 'Σ',
      '\\times': '×', '\\div': '÷', '\\pm': '±', '\\mp': '∓', '\\cdot': '·',
      '\\neq': '≠', '\\leq': '≤', '\\geq': '≥', '\\approx': '≈', '\\equiv': '≡',
      '\\ll': '≪', '\\gg': '≫', '\\propto': '∝',
      '\\in': '∈', '\\notin': '∉', '\\subset': '⊂', '\\supset': '⊃',
      '\\subseteq': '⊆', '\\supseteq': '⊇', '\\cup': '∪', '\\cap': '∩',
      '\\emptyset': '∅', '\\varnothing': '∅',
      '\\forall': '∀', '\\exists': '∃', '\\neg': '¬', '\\land': '∧', '\\lor': '∨',
      '\\to': '→', '\\rightarrow': '→', '\\leftarrow': '←',
      '\\Rightarrow': '⇒', '\\Leftarrow': '⇐', '\\Leftrightarrow': '⇔',
      '\\infty': '∞', '\\partial': '∂', '\\nabla': '∇',
      '\\therefore': '∴', '\\because': '∵',
      '\\sin': 'sin', '\\cos': 'cos', '\\tan': 'tan', '\\cot': 'cot',
      '\\sec': 'sec', '\\csc': 'csc',
      '\\log': 'log', '\\ln': 'ln', '\\lg': 'lg', '\\lim': 'lim',
      '\\max': 'max', '\\min': 'min',
      '\\ohm': 'Ω', '\\celsius': '℃',
      '\\quad': ' ', '\\qquad': '  ', '\\,': ' ', '\\;': ' ', '\\!': '',
      '\\left': '', '\\right': '', '\\big': '', '\\Big': '',
      '\\{': '{', '\\}': '}',
    };

    for (const [latex, unicode] of Object.entries(symbolMap)) {
      const escaped = latex.replace(/\\/g, '\\\\');
      r = r.replace(new RegExp(escaped, 'g'), unicode);
    }

    // 5. 清理残留命令：仅去掉前导反斜杠，避免误删普通字母
    r = r.replace(/\\([a-zA-Z]+)(?=\s|[{}()[\],.;:!?+\-*/=<>]|$)/g, '$1');
    r = r.replace(/\\([{}$%&_#])/g, '$1');
    r = r.replace(/\\/g, '');

    // 6. 清理多余空格
    r = r.replace(/\s{2,}/g, ' ').trim();

    return r;
  }

  // 上标/下标转换
  const superMap = { '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','+':'⁺','-':'⁻','=':'⁼','(':'⁽',')':'⁾','n':'ⁿ','i':'ⁱ' };
  const subMap = { '0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉','+':'₊','-':'₋','=':'₌','(':'₍',')':'₎','n':'ₙ','i':'ᵢ' };

  function toSuperscript(s) { return s.split('').map(c => superMap[c] || c).join(''); }
  function toSubscript(s) { return s.split('').map(c => subMap[c] || c).join(''); }

  // 遍历所有题目
  for (const group of exam.questions) {
    if (group.title) group.title = cleanLatex(group.title);
    if (!group.items || !Array.isArray(group.items)) continue;

    for (const item of group.items) {
      if (!item) continue;
      if (item.stem) item.stem = cleanLatex(item.stem);
      if (item.answer) item.answer = cleanLatex(String(item.answer));
      if (item.explanation) item.explanation = cleanLatex(String(item.explanation));
      if (item.options && Array.isArray(item.options)) {
        item.options = item.options.map(opt => cleanLatex(opt));
      }
      if (item.figure && typeof item.figure === 'object' && item.figure.description) {
        item.figure.description = cleanLatex(String(item.figure.description));
      }
    }
  }

  // 处理answers数组
  if (exam.answers && Array.isArray(exam.answers)) {
    exam.answers = exam.answers.map(ans => cleanLatex(ans));
  }
}

module.exports = {
  generateContent,
  generateTopicSuggestions,
  generateExam,
  analyzeWrongQuestion,
  generateWrongQuestionPractice
};
