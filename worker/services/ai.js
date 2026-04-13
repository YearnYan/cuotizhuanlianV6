import OpenAI from 'openai';

// ============================================================
// 质量约束常量（第一层 + 第五层）
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

function normalizeBaseURL(apiURL) {
  const input = String(apiURL || '').trim();
  if (!input) return 'https://api.linapi.net/v1';
  return input.replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '');
}

export function createAIClient(env) {
  const apiKey = env.AI_API_KEY;
  if (!apiKey) throw new Error('缺少 AI_API_KEY 环境变量');
  const baseURL = normalizeBaseURL(env.AI_API_URL);
  return new OpenAI({ apiKey, baseURL });
}

function extractTextContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
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
  if (!imageUrls.length) return text;

  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const imageUrl of imageUrls) {
    if (!imageUrl || typeof imageUrl !== 'string') continue;
    content.push({ type: 'image_url', image_url: { url: imageUrl } });
  }
  return content.length ? content : text;
}

export async function generateContent(client, env, systemPrompt, userPrompt, options = {}) {
  const model = options.model || env.AI_MODEL || 'gemini-3.1-pro-preview';
  const completion = await client.chat.completions.create({
    model,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens || 8000,
    messages: [
      { role: 'system', content: String(systemPrompt || '') },
      { role: 'user', content: buildUserMessageContent(userPrompt, options) }
    ]
  });

  const text = extractTextContent(completion?.choices?.[0]?.message?.content);
  if (!text) throw new Error('API返回空内容');
  return text;
}

export function parseJsonResponse(content, fallbackErrorMessage = 'AI返回格式不正确，请重试') {
  let jsonStr = String(content || '').trim();
  jsonStr = jsonStr.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');

  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
  }

  // Fix real newlines inside strings
  let fixed = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (escaped) { fixed += ch; escaped = false; continue; }
    if (ch === '\\') { fixed += ch; escaped = true; continue; }
    if (ch === '"') { fixed += ch; inString = !inString; continue; }
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
    // Fix single-backslash illegal escapes
    let fixed2 = '';
    let inStr = false;
    let esc = false;
    for (let i = 0; i < jsonStr.length; i++) {
      const ch = jsonStr[i];
      if (esc) {
        if ('"\\/bfnrtu'.includes(ch)) { fixed2 += ch; }
        else { fixed2 += '\\' + ch; }
        esc = false;
        continue;
      }
      if (ch === '"' && (i === 0 || jsonStr[i - 1] !== '\\')) {
        inStr = !inStr; fixed2 += ch; continue;
      }
      if (ch === '\\' && inStr) { fixed2 += ch; esc = true; continue; }
      fixed2 += ch;
    }

    try {
      return JSON.parse(fixed2);
    } catch (e2) {
      console.error('JSON解析失败:', e2.message);
      throw new Error(fallbackErrorMessage);
    }
  }
}

export async function generateTopicSuggestions(client, env, { version, grade, subject, keyword, imageUrls = [] }) {
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

  const content = await generateContent(client, env, systemPrompt, userPrompt, { imageUrls });
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.match(/^[\d\-\*\.]+/))
    .slice(0, 6);
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

function ensureAnswersFromQuestions(exam) {
  if (Array.isArray(exam.answers) && exam.answers.length > 0) return;
  const answers = [];
  if (!Array.isArray(exam.questions)) { exam.answers = answers; return; }
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
      if (!hasFigure) { item.figure = null; continue; }
      if (!item.figure) {
        item.figure = { type: 'diagram', description: `根据题干"${String(item.stem || '').slice(0, 60)}"绘制清晰示意图，包含关键已知量、标注与关系。` };
        continue;
      }
      if (typeof item.figure === 'string') {
        const desc = item.figure.trim();
        item.figure = { type: 'diagram', description: desc || `根据题干"${String(item.stem || '').slice(0, 60)}"绘制示意图。` };
        continue;
      }
      if (typeof item.figure === 'object') {
        if (!item.figure.type) item.figure.type = 'diagram';
        if (!item.figure.description || !String(item.figure.description).trim()) {
          item.figure.description = `根据题干"${String(item.stem || '').slice(0, 60)}"绘制示意图。`;
        }
      }
    }
  }
}

export async function generateExam(client, env, params) {
  const {
    version = '人教版', grade = '', subject = '', topics = '', examPoints = '',
    difficulty = 5, questionCount = 12, questionTypes = '选择题、填空题、解答题',
    difficultyPrompt = '', imageUrls = []
  } = params;

  const topicsText = Array.isArray(topics) ? topics.join('、') : String(topics || '');
  const examPointsText = Array.isArray(examPoints) ? examPoints.join('、') : String(examPoints || '');

  const systemPrompt = `你是一位拥有20年教学经验的资深${subject}教师，精通${version || '各版本'}教材体系，请生成高质量中文试卷。

要求：
1. 严格输出 JSON，禁止 markdown 包裹
2. 题目有梯度，由易到难
3. 每题必须提供 answer 与 explanation
4. 禁止使用 LaTeX，使用纯文本与 Unicode 符号（如 ²、√、π、≤、≥ 等）
5. 如果题目需要图形，可使用 figure 字段描述图形，禁止使用"如图所示"等模糊表述
${QUALITY_CONSTRAINTS}${ORIGINALITY_CONSTRAINTS}`;

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

  const content = await generateContent(client, env, systemPrompt, userPrompt, {
    maxTokens: 8000, temperature: 0.3, imageUrls
  });

  const exam = parseJsonResponse(content, 'AI返回的试卷格式不正确，请重试');
  if (!exam.questions || !Array.isArray(exam.questions) || exam.questions.length === 0) {
    throw new Error('AI未生成有效题目，请重试');
  }

  postProcessFigures(exam);
  postProcessLatexSymbols(exam);
  ensureAnswersFromQuestions(exam);

  // 第三层：AI 二次审校
  await reviewExamQuestions(client, env, exam);

  // 第四层：结构化硬规则校验 + 自动修复
  const validation = validateExam(exam);
  if (validation.fixedItems.length > 0) {
    console.log(`[校验] 自动修复: ${validation.fixedItems.join('; ')}`);
    ensureAnswersFromQuestions(exam);
  }
  if (validation.errors.length > 0) {
    console.warn(`[校验] 发现结构问题: ${validation.errors.join('; ')}`);
  }
  if (validation.warnings.length > 0) {
    console.warn(`[校验] 警告: ${validation.warnings.join('; ')}`);
  }

  exam.metadata = {
    version, grade, subject, topics: topicsText, examPoints: examPointsText,
    difficulty, generatedAt: new Date().toISOString()
  };
  return exam;
}

export async function analyzeWrongQuestion(client, env, { fileName = '', mimeType = '', previewImageUrl = '', extractedText = '' }) {
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
  "subject": "科目",
  "grade": "年级",
  "knowledgePoints": ["知识点1", "知识点2"],
  "examPoints": ["考点1", "考点2"],
  "answerAnalysis": "解题思路与答案解析，80~220字",
  "hasFigure": true,
  "originalQuestionText": "原题题干转写",
  "needsWholeQuestion": false,
  "wholeQuestionAdvice": "当英语题上下文不足时给出提示，否则为空字符串"
}

约束：
1. knowledgePoints 与 examPoints 均返回 2~6 条
2. hasFigure 只返回 true 或 false
3. originalQuestionText 尽量完整
4. 若 subject=英语 且语篇上下文不足，needsWholeQuestion=true，wholeQuestionAdvice 给出“请上传包含完整文章与全部小问的一整题”类型提示
5. 其他情况 needsWholeQuestion=false，wholeQuestionAdvice 返回空字符串`;

  const content = await generateContent(client, env, systemPrompt, userPrompt, {
    maxTokens: 2200, temperature: 0.2,
    imageUrls: previewImageUrl ? [previewImageUrl] : []
  });

  const parsed = parseJsonResponse(content, 'AI返回的错题解析格式不正确，请重试');
  const normalizeList = (value) => {
    if (!Array.isArray(value)) return [];
    return value.map(item => String(item || '').trim()).filter(Boolean).slice(0, 8);
  };

  return {
    subject: String(parsed.subject || '').trim(),
    grade: String(parsed.grade || '').trim(),
    knowledgePoints: normalizeList(parsed.knowledgePoints),
    examPoints: normalizeList(parsed.examPoints),
    answerAnalysis: String(parsed.answerAnalysis || '').trim(),
    hasFigure: Boolean(parsed.hasFigure),
    originalQuestionText: String(parsed.originalQuestionText || '').trim(),
    needsWholeQuestion: Boolean(parsed.needsWholeQuestion),
    wholeQuestionAdvice: String(parsed.wholeQuestionAdvice || '').trim()
  };
}

export async function generateWrongQuestionPractice(client, env, params) {
  const {
    subject = '', grade = '', knowledgePoints = [], examPoints = [],
    answerAnalysis = '', sourceQuestionText = '', hasFigure = false,
    questionTypes = ['相似题', '变式题', '综合应用题'],
    questionTypeCounts = {}, questionCount = 3, imageUrls = []
  } = params;

  const titleMap = { similar: '相似题', variant: '变式题', application: '综合应用题' };
  const defaultTypeCounts = { similar: 1, variant: 1, application: 1 };
  const clampTypeCount = (value) => {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) return 2;
    return Math.min(5, Math.max(1, parsed));
  };

  const normalizedTypes = Array.isArray(questionTypes) && questionTypes.length > 0
    ? questionTypes.map(item => String(item || '').trim()).filter(Boolean)
    : ['相似题', '变式题', '综合应用题'];

  const selectedOrder = Array.from(new Set(
    normalizedTypes
      .map(type => normalizeQuestionTypeLabel(type))
      .filter(key => ['similar', 'variant', 'application'].includes(key))
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

  const totalCount = Math.max(1,
    parseInt(questionCount, 10)
    || finalOrder.reduce((sum, key) => sum + selectedTypeCountMap[key], 0)
    || 9
  );

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
8. 如果 hasFigure=true，则每题必须包含 figure；如果 hasFigure=false，则所有题目不包含 figure
${QUALITY_CONSTRAINTS}${ORIGINALITY_CONSTRAINTS}`;

  const userPrompt = `请基于以下错题信息生成专练题：

科目：${subject || '未指定'}
年级：${grade || '未指定'}
知识点：${knowledgePoints.join('、') || '未指定'}
考点：${examPoints.join('、') || '未指定'}
原题题干：${sourceQuestionText || '未提供'}
原题解析：${answerAnalysis || '未提供'}
图形约束：${hasFigure ? '每题必须有图形' : '每题不需要图形'}
题型选择：${normalizedTypes.join('、')}
各题型数量：${finalOrder.map(key => `${titleMap[key]}${selectedTypeCountMap[key]}道`).join('，')}
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

  const content = await generateContent(client, env, systemPrompt, userPrompt, {
    maxTokens: 8000, temperature: 0.3, imageUrls
  });

  const exam = parseJsonResponse(content, 'AI返回的试卷格式不正确，请重试');
  if (!exam.questions || !Array.isArray(exam.questions) || exam.questions.length === 0) {
    throw new Error('AI未生成有效题目，请重试');
  }

  const grouped = {};
  let fallbackGroupKey = normalizeQuestionTypeLabel(normalizedTypes[0] || '相似题');
  if (!['similar', 'variant', 'application'].includes(fallbackGroupKey)) fallbackGroupKey = 'similar';

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
    if (items.length < targetCount) throw new Error(`${titleMap[key]}数量不足，请重试`);
    normalizedQuestions.push({
      type: key,
      title: titleMap[key],
      items: items.map(item => ({ ...item, index: globalIndex++ }))
    });
  }

  if (normalizedQuestions.length === 0) throw new Error('AI未生成有效题目，请重试');

  exam.questions = normalizedQuestions;
  postProcessFigures(exam);
  postProcessLatexSymbols(exam);
  enforceFigureMode(exam, hasFigure);
  ensureAnswersFromQuestions(exam);

  // 第三层：AI 二次审校
  await reviewExamQuestions(client, env, exam);

  // 第四层：结构化硬规则校验 + 自动修复
  const validation = validateExam(exam);
  if (validation.fixedItems.length > 0) {
    console.log(`[校验] 自动修复: ${validation.fixedItems.join('; ')}`);
    ensureAnswersFromQuestions(exam);
  }
  if (validation.errors.length > 0) {
    console.warn(`[校验] 发现结构问题: ${validation.errors.join('; ')}`);
  }
  if (validation.warnings.length > 0) {
    console.warn(`[校验] 警告: ${validation.warnings.join('; ')}`);
  }

  exam.metadata = {
    subject, grade, knowledgePoints, examPoints,
    questionTypeCounts: selectedTypeCountMap, hasFigure,
    generatedAt: new Date().toISOString(),
    source: 'wrong-question-practice'
  };
  return exam;
}

// ============================================================
// 第三层：AI 二次审校（Review Chain）
// ============================================================

async function reviewExamQuestions(client, env, exam) {
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
      "correctedExplanation": "修正后的解析（仅当需要修正时）"
    }
  ]
}

注意：
- passed=true 表示该题完全正确，不需要提供修正字段
- passed=false 表示该题有问题，必须提供修正后的相应字段
- 只需提供需要修正的字段`;

  try {
    console.log(`[审校] 开始审校 ${allItems.length} 道题...`);
    const content = await generateContent(client, env, reviewSystemPrompt, reviewUserPrompt, {
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

      correctedCount++;
      console.log(`[审校] 题${review.index} 已修正: ${(review.issues || []).join('; ')}`);
    }

    if (correctedCount > 0) {
      console.log(`[审校] 共修正 ${correctedCount}/${allItems.length} 道题`);
      exam.answers = [];
      ensureAnswersFromQuestions(exam);
    } else {
      console.log('[审校] 所有题目审校通过');
    }
  } catch (error) {
    console.error('[审校] 审校过程出错，跳过审校:', error.message);
  }
}

// ============================================================
// 第四层：结构化硬规则校验器（内联版，Worker 无法 require）
// ============================================================

function validateExam(exam) {
  const errors = [];
  const warnings = [];
  const fixedItems = [];

  if (!exam.questions || !Array.isArray(exam.questions)) {
    errors.push('试卷缺少 questions 数组');
    return { valid: false, errors, warnings, fixedItems };
  }

  for (const group of exam.questions) {
    if (!group || !Array.isArray(group.items)) continue;
    for (const item of group.items) {
      if (!item) continue;
      const idx = item.index || '?';

      if (!item.answer || !String(item.answer).trim()) {
        errors.push(`题${idx}: answer 为空`);
      }
      if (!item.explanation || !String(item.explanation).trim()) {
        errors.push(`题${idx}: explanation 为空`);
      }
      if (!item.stem || String(item.stem).trim().length < 8) {
        errors.push(`题${idx}: 题干过短或为空`);
      }

      if (item.options && Array.isArray(item.options) && item.options.length > 0) {
        if (item.options.length < 2) {
          errors.push(`题${idx}: 选项数量不足`);
        }
        const answerStr = String(item.answer || '').trim();
        const validLetters = item.options.map((_, i) => String.fromCharCode(65 + i));
        const firstChar = answerStr.charAt(0).toUpperCase();

        if (answerStr.length === 1 && validLetters.includes(answerStr.toUpperCase())) {
          if (item.answer !== firstChar) {
            item.answer = firstChar;
            fixedItems.push(`题${idx}: answer 规范化为 "${firstChar}"`);
          }
        } else if (answerStr.length > 1) {
          const letterMatch = answerStr.match(/^([A-Da-d])/);
          if (letterMatch) {
            const letter = letterMatch[1].toUpperCase();
            if (validLetters.includes(letter)) {
              item.answer = letter;
              fixedItems.push(`题${idx}: answer 规范化为 "${letter}"`);
            }
          } else {
            warnings.push(`题${idx}: answer "${answerStr}" 不是标准选项字母格式`);
          }
        } else if (!validLetters.includes(firstChar)) {
          errors.push(`题${idx}: answer "${answerStr}" 不在选项范围内`);
        }

        for (let i = 0; i < item.options.length; i++) {
          if (!String(item.options[i] || '').trim()) {
            errors.push(`题${idx}: 选项${String.fromCharCode(65 + i)}为空`);
          }
        }

        const optTexts = item.options.map(o => String(o || '').replace(/^[A-D][.、．]\s*/, '').trim());
        if (new Set(optTexts).size < optTexts.length) {
          warnings.push(`题${idx}: 存在重复选项`);
        }
      }

      const stemStr = String(item.stem || '');
      if (/[^\u4e00-\u9fa5a-zA-Z0-9\s.,;:!?()（）【】\[\]、。，；：！？""''…—\-+×÷=≈≠≤≥<>°%√πα-ωΑ-Ω²³⁴⁵⁶⁷⁸⁹⁰₀₁₂₃₄₅₆₇₈₉∠△∥⊥≅∽□∈∉⊂⊃∪∩∅∀∃→←⇒⇔∞∴∵·±∓/\\_{}|~@#$&*^`'"\n\r\t]{4,}/.test(stemStr)) {
        warnings.push(`题${idx}: 题干可能包含乱码`);
      }

      if (item.explanation && item.answer && item.options && Array.isArray(item.options)) {
        const letter = String(item.answer).charAt(0).toUpperCase();
        if (letter >= 'A' && letter <= 'D') {
          const optIdx = letter.charCodeAt(0) - 65;
          const optContent = item.options[optIdx]
            ? String(item.options[optIdx]).replace(/^[A-D][.、．]\s*/, '').trim() : '';
          if (!String(item.explanation).includes(letter) &&
              (!optContent || !String(item.explanation).includes(optContent.substring(0, 10)))) {
            warnings.push(`题${idx}: 解析中未提及正确选项 ${letter}`);
          }
        }
      }

      if (/如图|见图|下图|图中|由图/.test(stemStr) && !item.figure) {
        warnings.push(`题${idx}: 题干提到图形引用但缺少 figure`);
      }

      if (item.explanation && String(item.explanation).trim().length < 15) {
        warnings.push(`题${idx}: explanation 过短`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings, fixedItems };
}

function postProcessFigures(exam) {
  if (!exam.questions || !Array.isArray(exam.questions)) return;
  const figureRefPattern = /如图[所示]*[，,]?|[如见]下图[所示]*[，,]?|图中[所示]*[，,]?|由图[可知]*[，,]?/g;

  for (const group of exam.questions) {
    if (!group.items || !Array.isArray(group.items)) continue;
    for (const item of group.items) {
      if (!item || !item.stem) continue;
      const hasFigureRef = figureRefPattern.test(item.stem);
      figureRefPattern.lastIndex = 0;
      const hasFigure = item.figure &&
        (typeof item.figure === 'string' ? item.figure.trim() : item.figure.description?.trim());

      if (hasFigureRef && !hasFigure) {
        item.stem = item.stem.replace(figureRefPattern, '');
        item.stem = item.stem.replace(/^\s*[，,]\s*/, '').trim();
        item.figure = null;
      }
      if (item.figure) {
        if (typeof item.figure === 'string') {
          const desc = item.figure.trim();
          item.figure = desc ? { type: 'diagram', description: desc } : null;
        } else if (typeof item.figure === 'object') {
          if (!item.figure.description || !item.figure.description.trim()) item.figure = null;
        }
      }
    }
  }
}

function postProcessLatexSymbols(exam) {
  if (!exam.questions || !Array.isArray(exam.questions)) return;

  const superMap = {'0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','+':'⁺','-':'⁻','=':'⁼','(':'⁽',')':'⁾','n':'ⁿ','i':'ⁱ'};
  const subMap = {'0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉','+':'₊','-':'₋','=':'₌','(':'₍',')':'₎','n':'ₙ','i':'ᵢ'};
  function toSuperscript(s) { return s.split('').map(c => superMap[c] || c).join(''); }
  function toSubscript(s) { return s.split('').map(c => subMap[c] || c).join(''); }

  function cleanLatex(text) {
    if (!text || typeof text !== 'string') return text;
    let r = text;
    r = r.replace(/\$\$(.*?)\$\$/g, '$1');
    r = r.replace(/\$(.*?)\$/g, '$1');
    r = r.replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)');
    r = r.replace(/\\sqrt\[(\d+)\]\{([^}]*)\}/g, '$1√($2)');
    r = r.replace(/\\sqrt\{([^}]*)\}/g, '√($1)');
    r = r.replace(/\\overrightarrow\{([^}]*)\}/g, '→$1');
    r = r.replace(/\\vec\{([^}]*)\}/g, '→$1');
    r = r.replace(/\\overline\{([^}]*)\}/g, '$1');
    r = r.replace(/\\underline\{([^}]*)\}/g, '$1');
    r = r.replace(/\\mathbb\{([^}]*)\}/g, '$1');
    r = r.replace(/\\mathrm\{([^}]*)\}/g, '$1');
    r = r.replace(/\\text\{([^}]*)\}/g, '$1');

    r = r.replace(/\^\{([^}]*)\}/g, (_, p) => toSuperscript(p));
    r = r.replace(/_\{([^}]*)\}/g, (_, p) => toSubscript(p));
    r = r.replace(/\^(\d)/g, (_, d) => toSuperscript(d));
    r = r.replace(/_(\d)/g, (_, d) => toSubscript(d));

    const symbolMap = {
      '\\angle': '∠', '\\triangle': '△', '\\circ': '°', '\\degree': '°',
      '\\parallel': '∥', '\\perp': '⊥', '\\cong': '≅', '\\sim': '∽', '\\square': '□',
      '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ', '\\epsilon': 'ε',
      '\\theta': 'θ', '\\lambda': 'λ', '\\mu': 'μ', '\\pi': 'π', '\\sigma': 'σ',
      '\\phi': 'φ', '\\omega': 'ω', '\\Delta': 'Δ', '\\Omega': 'Ω',
      '\\times': '×', '\\div': '÷', '\\pm': '±', '\\cdot': '·',
      '\\neq': '≠', '\\leq': '≤', '\\geq': '≥', '\\approx': '≈', '\\equiv': '≡',
      '\\in': '∈', '\\subset': '⊂', '\\cup': '∪', '\\cap': '∩', '\\emptyset': '∅',
      '\\forall': '∀', '\\exists': '∃', '\\neg': '¬',
      '\\to': '→', '\\rightarrow': '→', '\\leftarrow': '←',
      '\\Rightarrow': '⇒', '\\Leftrightarrow': '⇔',
      '\\infty': '∞', '\\therefore': '∴', '\\because': '∵',
      '\\sin': 'sin', '\\cos': 'cos', '\\tan': 'tan',
      '\\log': 'log', '\\ln': 'ln', '\\lg': 'lg', '\\lim': 'lim',
      '\\quad': ' ', '\\qquad': '  ', '\\,': ' ', '\\;': ' ', '\\!': '',
      '\\left': '', '\\right': '', '\\{': '{', '\\}': '}',
    };
    for (const [latex, unicode] of Object.entries(symbolMap)) {
      const escaped = latex.replace(/\\/g, '\\\\');
      r = r.replace(new RegExp(escaped, 'g'), unicode);
    }
    r = r.replace(/\\[a-zA-Z]+/g, '');
    r = r.replace(/\s{2,}/g, ' ').trim();
    return r;
  }

  for (const group of exam.questions) {
    if (group.title) group.title = cleanLatex(group.title);
    if (!group.items || !Array.isArray(group.items)) continue;
    for (const item of group.items) {
      if (!item) continue;
      if (item.stem) item.stem = cleanLatex(item.stem);
      if (item.options && Array.isArray(item.options)) {
        item.options = item.options.map(opt => cleanLatex(opt));
      }
    }
  }
  if (exam.answers && Array.isArray(exam.answers)) {
    exam.answers = exam.answers.map(ans => cleanLatex(ans));
  }
}
