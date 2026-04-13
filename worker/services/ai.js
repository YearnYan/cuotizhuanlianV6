import OpenAI from 'openai';
import { acquireAIKeyLease } from './ai-key-pool.js';

function normalizeBaseURL(apiURL) {
  const input = String(apiURL || '').trim();
  if (!input) return 'https://api.linapi.net/v1';
  return input.replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '');
}

function parseApiKeys(env) {
  const keysFromList = String(env?.AI_API_KEYS || '')
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const single = String(env?.AI_API_KEY || '').trim();
  return Array.from(new Set([...keysFromList, single].filter(Boolean)));
}

export function createAIClient(env, apiKeyOverride = '') {
  const keys = parseApiKeys(env);
  const apiKey = String(apiKeyOverride || keys[0] || '').trim();
  if (!apiKey) throw new Error('缺少 AI_API_KEY 或 AI_API_KEYS 环境变量');
  return new OpenAI({
    apiKey,
    baseURL: normalizeBaseURL(env?.AI_API_URL)
  });
}

function extractTextContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
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
  if (!imageUrls.length) return text;

  const content = [];
  if (text) {
    content.push({ type: 'text', text });
  }
  for (const imageUrl of imageUrls) {
    if (!imageUrl || typeof imageUrl !== 'string') continue;
    content.push({ type: 'image_url', image_url: { url: imageUrl } });
  }
  return content.length ? content : text;
}

export async function generateContent(client, env, systemPrompt, userPrompt, options = {}) {
  const lease = acquireAIKeyLease(env);
  try {
    const runtimeClient = createAIClient(env, lease.apiKey);
    const completion = await runtimeClient.chat.completions.create({
      model: options.model || env?.AI_MODEL || 'gemini-3.1-pro-preview',
      temperature: options.temperature ?? 0.4,
      max_tokens: options.maxTokens || 8000,
      messages: [
        { role: 'system', content: String(systemPrompt || '') },
        { role: 'user', content: buildUserMessageContent(userPrompt, options) }
      ]
    });

    const text = extractTextContent(completion?.choices?.[0]?.message?.content);
    if (!text) throw new Error('API返回空内容');
    lease.release(true);
    return text;
  } catch (error) {
    lease.release(false, error);
    const status = error?.status || error?.response?.status;
    const reason = error?.error?.message || error?.message || '未知错误';
    if (status) throw new Error(`AI生成失败: API返回 ${status} - ${reason}`);
    throw new Error(`AI生成失败: ${reason}`);
  }
}

export function parseJsonResponse(content, fallbackErrorMessage = 'AI返回格式不正确，请重试') {
  let jsonStr = String(content || '').trim();
  jsonStr = jsonStr
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '');

  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(jsonStr);
  } catch {
    throw new Error(fallbackErrorMessage);
  }
}

function normalizeAnswerList(exam) {
  if (!Array.isArray(exam.questions)) {
    exam.questions = [];
  }
  const answers = [];
  let index = 1;
  for (const group of exam.questions) {
    if (!Array.isArray(group?.items)) continue;
    group.items = group.items
      .filter(Boolean)
      .map((item) => {
        const next = {
          ...item,
          index
        };
        const answer = String(item?.answer || '').trim() || '略';
        const explanation = String(item?.explanation || '').trim();
        answers.push(`${index}. ${answer}${explanation ? ` 解析：${explanation}` : ''}`);
        index += 1;
        return next;
      });
  }
  exam.answers = answers;
}

function sanitizePracticeExam(exam, fallbackTitle = '错题啄木鸟-定制练习') {
  const safe = exam && typeof exam === 'object' ? exam : {};
  const questions = Array.isArray(safe.questions) ? safe.questions : [];
  const normalized = [];

  for (const group of questions) {
    if (!Array.isArray(group?.items) || group.items.length === 0) continue;
    normalized.push({
      type: String(group.type || 'other'),
      title: String(group.title || '练习题'),
      items: group.items.map((item) => ({
        stem: String(item?.stem || ''),
        options: Array.isArray(item?.options) ? item.options.map((opt) => String(opt || '')) : [],
        answer: String(item?.answer || ''),
        explanation: String(item?.explanation || ''),
        figure: item?.figure || null
      }))
    });
  }

  const result = {
    title: String(safe.title || fallbackTitle),
    questions: normalized
  };
  normalizeAnswerList(result);
  return result;
}

export async function generateTopicSuggestions(client, env, { version, grade, subject, keyword, imageUrls = [] }) {
  const systemPrompt = `你是一位K12学科教师。请根据用户输入生成4到6个可执行的知识点建议。输出纯文本，每行一个知识点。`;
  const userPrompt = `教材版本：${version}\n年级：${grade}\n科目：${subject}\n关键词：${keyword}`;
  const content = await generateContent(client, env, systemPrompt, userPrompt, {
    imageUrls,
    temperature: 0.3,
    maxTokens: 1200
  });

  return content
    .split('\n')
    .map((line) => line.replace(/^[\d\-\.\s、]+/, '').trim())
    .filter(Boolean)
    .slice(0, 6);
}

export async function analyzeWrongQuestion(client, env, {
  fileName = '',
  mimeType = '',
  previewImageUrl = '',
  extractedText = ''
}) {
  const systemPrompt = `你是中小学错题分析助手。请返回JSON：
{
  "subject":"学科",
  "grade":"年级",
  "knowledgePoints":["所学1","所学2"],
  "examPoints":["所考1","所考2"],
  "answerAnalysis":"简要解析",
  "originalQuestionText":"题目原文",
  "hasFigure":false,
  "needsWholeQuestion":false,
  "wholeQuestionAdvice":""
}
规则：英语阅读、完形、语篇题若上下文不足，needsWholeQuestion必须为true。`;

  const userPrompt = `文件名：${fileName}\n文件类型：${mimeType}\nOCR文本：${extractedText || '无'}\n请分析错题。`;
  const content = await generateContent(client, env, systemPrompt, userPrompt, {
    imageUrls: previewImageUrl ? [previewImageUrl] : [],
    temperature: 0.2,
    maxTokens: 2500
  });

  const parsed = parseJsonResponse(content, '错题解析格式异常，请重试');
  return {
    subject: String(parsed.subject || ''),
    grade: String(parsed.grade || ''),
    knowledgePoints: Array.isArray(parsed.knowledgePoints) ? parsed.knowledgePoints.map((v) => String(v || '').trim()).filter(Boolean) : [],
    examPoints: Array.isArray(parsed.examPoints) ? parsed.examPoints.map((v) => String(v || '').trim()).filter(Boolean) : [],
    answerAnalysis: String(parsed.answerAnalysis || '').trim(),
    originalQuestionText: String(parsed.originalQuestionText || extractedText || '').trim(),
    hasFigure: Boolean(parsed.hasFigure),
    needsWholeQuestion: Boolean(parsed.needsWholeQuestion),
    wholeQuestionAdvice: String(parsed.wholeQuestionAdvice || '').trim()
  };
}

export async function generateWrongQuestionPractice(client, env, {
  subject,
  grade,
  knowledgePoints = [],
  examPoints = [],
  answerAnalysis = '',
  sourceQuestionText = '',
  hasFigure = false,
  questionTypes = [],
  questionTypeCounts = {},
  questionCount = 3,
  imageUrls = []
}) {
  const safeTypes = Array.isArray(questionTypes) && questionTypes.length > 0
    ? questionTypes
    : ['相似题', '变式题', '综合应用题'];

  const systemPrompt = `你是一位资深中小学教师，请按要求生成“错题专练”试卷，必须返回JSON。
输出格式：
{
  "title":"错题啄木鸟-定制练习",
  "questions":[
    {
      "type":"similar|variant|application",
      "title":"分组标题",
      "items":[
        {
          "stem":"题干",
          "options":["A. ...","B. ...","C. ...","D. ..."],
          "answer":"答案",
          "explanation":"解析",
          "figure":{"type":"diagram","description":"图形描述"}
        }
      ]
    }
  ]
}
规则：
1. 只输出JSON，不要Markdown。
2. 若题目非选择题，options可为空数组。
3. hasFigure为true时，每题都要有figure；为false时figure为null。
4. 所学与所考必须紧贴用户提供内容。`;

  const userPrompt = `科目：${subject}\n年级：${grade}\n所学：${knowledgePoints.join('、')}\n所考：${examPoints.join('、')}\n原题：${sourceQuestionText}\n原题解析：${answerAnalysis}\n题型：${safeTypes.join('、')}\n题量：${questionCount}\n每类数量：${JSON.stringify(questionTypeCounts)}\n图形要求：${hasFigure ? '每题需要图形' : '不需要图形'}`;
  const content = await generateContent(client, env, systemPrompt, userPrompt, {
    imageUrls,
    temperature: 0.35,
    maxTokens: 7000
  });
  const parsed = parseJsonResponse(content, 'AI返回的练习题格式异常，请重试');
  return sanitizePracticeExam(parsed, '错题啄木鸟-定制练习');
}

export async function generateExam(client, env, {
  version,
  grade,
  subject,
  topics,
  examPoints,
  difficulty,
  questionTypes,
  questionCount,
  difficultyPrompt,
  imageUrls = []
}) {
  const systemPrompt = `你是一位中小学命题老师，请按要求生成试卷并返回JSON。
格式：
{
  "title":"试卷标题",
  "questions":[
    {
      "type":"custom",
      "title":"题目列表",
      "items":[
        {"stem":"题干","options":[],"answer":"答案","explanation":"解析","figure":null}
      ]
    }
  ]
}
必须是纯JSON。`;

  const userPrompt = `教材：${version}\n年级：${grade}\n科目：${subject}\n主题：${topics}\n考点：${examPoints}\n难度：${difficulty}\n难度说明：${difficultyPrompt || ''}\n题型：${questionTypes}\n题量：${questionCount}`;
  const content = await generateContent(client, env, systemPrompt, userPrompt, {
    imageUrls,
    temperature: 0.35,
    maxTokens: 7000
  });
  const parsed = parseJsonResponse(content, 'AI返回的试卷格式异常，请重试');
  return sanitizePracticeExam(parsed, `${grade}${subject}试卷`);
}

