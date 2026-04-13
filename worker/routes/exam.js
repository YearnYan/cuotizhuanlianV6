import {
  createAIClient,
  generateTopicSuggestions,
  generateExam,
  analyzeWrongQuestion,
  generateWrongQuestionPractice
} from '../services/ai.js';
import { consumePoint, refundPoint } from '../services/account-store.js';
import { getDifficultyPrompt } from '../prompts/difficulty-levels.js';

const EXAM_TYPE_NAMES = {
  quiz: '随堂小测',
  unit: '单元测试',
  midterm: '期中考试',
  final: '期末考试',
  mock: '模拟考试'
};

const PRACTICE_TYPES = ['相似题', '变式题', '综合应用题'];
const PRACTICE_TYPE_CODES = ['similar', 'variant', 'application'];
const PRACTICE_QUESTION_TYPES = [
  { label: '相似题', code: 'similar' },
  { label: '变式题', code: 'variant' },
  { label: '综合应用题', code: 'application' }
];
const PRACTICE_DEFAULT_TYPE_COUNTS = {
  similar: 1,
  variant: 1,
  application: 1
};
const PRACTICE_COUNT_LIMITS = { min: 1, max: 5 };
const UPLOAD_ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'application/pdf'];
const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const TYPE_ORDER = {
  similar: 1,
  variant: 2,
  application: 3,
  choice: 10,
  fill: 11,
  blank: 11,
  calculation: 12,
  qa: 12,
  other: 99
};

function buildRuntimeConfig() {
  return {
    upload: {
      maxUploadSizeBytes: UPLOAD_MAX_BYTES,
      allowedMimeTypes: UPLOAD_ALLOWED_MIME_TYPES
    },
    practice: {
      questionTypes: PRACTICE_QUESTION_TYPES,
      defaultTypeCounts: PRACTICE_DEFAULT_TYPE_COUNTS,
      countLimits: PRACTICE_COUNT_LIMITS,
      typeOrders: TYPE_ORDER
    }
  };
}

function clampPracticeCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return 1;
  return Math.min(5, Math.max(1, parsed));
}

function normalizePracticeTypeCode(typeLike) {
  const text = String(typeLike || '').toLowerCase();
  if (text.includes('相似') || text.includes('similar')) return 'similar';
  if (text.includes('变式') || text.includes('variant')) return 'variant';
  if (text.includes('综合应用') || text.includes('application')) return 'application';
  return '';
}

function normalizeTextList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }

  const text = String(value || '').trim();
  if (!text) return [];
  return text
    .split(/[、,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function examRoutes(app) {
  app.get('/runtime-config', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(buildRuntimeConfig());
  });

  app.post('/suggest-topics', async (c) => {
    try {
      const body = await c.req.json();
      const { version, grade, subject, keyword, imageUrls = [] } = body;
      if (!keyword) {
        return c.json({ error: '请输入关键词' }, 400);
      }
      if (!Array.isArray(imageUrls)) {
        return c.json({ error: 'imageUrls 必须是数组' }, 400);
      }

      const client = createAIClient(c.env);
      const topics = await generateTopicSuggestions(client, c.env, {
        version,
        grade,
        subject,
        keyword,
        imageUrls
      });
      return c.json({ topics });
    } catch (error) {
      console.error('生成知识点建议失败:', error.message);
      return c.json({ error: `生成失败: ${error.message}` }, 500);
    }
  });

  app.post('/analyze-wrong-question', async (c) => {
    try {
      const body = await c.req.json();
      const {
        fileName = '',
        mimeType = '',
        previewImageUrl = '',
        extractedText = ''
      } = body;

      if (!previewImageUrl || typeof previewImageUrl !== 'string') {
        return c.json({ error: '缺少可识别的题目图片数据' }, 400);
      }
      if (!['image/png', 'image/jpeg', 'application/pdf'].includes(mimeType)) {
        return c.json({ error: '仅支持 PNG/JPG/PDF' }, 400);
      }

      const client = createAIClient(c.env);
      const result = await analyzeWrongQuestion(client, c.env, {
        fileName,
        mimeType,
        previewImageUrl,
        extractedText
      });
      return c.json(result);
    } catch (error) {
      console.error('解析错题失败:', error.message);
      return c.json({ error: `解析失败: ${error.message}` }, 500);
    }
  });

  app.post('/generate', async (c) => {
    let consumedPoint = false;
    let authUserId = 0;
    try {
      const body = await c.req.json();
      const client = createAIClient(c.env);
      const authUser = c.get('authUser');
      authUserId = Number(authUser?.id || 0);
      if (!authUserId) {
        return c.json({ error: '请先登录账号后再使用' }, 401);
      }

      const hasPracticePayload = (
        body.knowledgePoints !== undefined ||
        body.examPoints !== undefined ||
        body.sourceQuestionText !== undefined
      );

      if (hasPracticePayload) {
        const {
          subject = '',
          grade = '',
          knowledgePoints = [],
          examPoints = [],
          answerAnalysis = '',
          sourceQuestionText = '',
          sourceQuestionImage = '',
          hasFigure = false,
          questionTypes = [],
          questionTypeCounts = {},
          questionCount = 3
        } = body;

        const normalizedKnowledgePoints = normalizeTextList(knowledgePoints);
        const normalizedExamPoints = normalizeTextList(examPoints);
        const normalizedTypes = Array.isArray(questionTypes) && questionTypes.length > 0
          ? questionTypes.map((item) => String(item || '').trim()).filter(Boolean)
          : PRACTICE_TYPES;

        if (!normalizedKnowledgePoints.length && !normalizedExamPoints.length) {
          return c.json({ error: '缺少知识点或考点，请先上传错题并完成解析' }, 400);
        }

        const normalizedTypeCounts = {};
        for (const code of PRACTICE_TYPE_CODES) {
          normalizedTypeCounts[code] = clampPracticeCount(questionTypeCounts?.[code]);
        }

        const selectedTypeCodes = normalizedTypes
          .map((type) => normalizePracticeTypeCode(type))
          .filter(Boolean);
        const totalFromTypeCounts = selectedTypeCodes
          .reduce((sum, code) => sum + (normalizedTypeCounts[code] || 0), 0);

        const resolvedQuestionCount = Math.max(
          1,
          Number.parseInt(questionCount, 10) || totalFromTypeCounts || normalizedTypes.length
        );

        const userAfterCost = await consumePoint(c.env, {
          userId: authUserId,
          amount: 1,
          reason: 'practice_generate',
          metadata: {
            questionCount: resolvedQuestionCount,
            mode: 'practice'
          }
        });
        consumedPoint = true;

        const exam = await generateWrongQuestionPractice(client, c.env, {
          subject: subject || '通用',
          grade,
          knowledgePoints: normalizedKnowledgePoints,
          examPoints: normalizedExamPoints.length ? normalizedExamPoints : normalizedKnowledgePoints,
          answerAnalysis: String(answerAnalysis || '').trim(),
          sourceQuestionText: String(sourceQuestionText || '').trim(),
          hasFigure: Boolean(hasFigure),
          questionTypes: normalizedTypes,
          questionTypeCounts: normalizedTypeCounts,
          questionCount: resolvedQuestionCount,
          imageUrls: sourceQuestionImage ? [sourceQuestionImage] : []
        });

        return c.json({
          ...exam,
          userPoints: userAfterCost.points
        });
      }

      const {
        version = '人教版',
        grade,
        subject,
        topic,
        examPoint,
        difficulty = 5,
        examType = 'final',
        questionTypes = [],
        questionCount = 15,
        imageUrls = []
      } = body;

      if (!grade || !subject || !topic) {
        return c.json({ error: '缺少必填参数: grade, subject, topic' }, 400);
      }
      if (!Array.isArray(imageUrls)) {
        return c.json({ error: 'imageUrls 必须是数组' }, 400);
      }

      const difficultyPrompt = getDifficultyPrompt(
        Number.parseInt(difficulty, 10),
        grade,
        subject
      );

      let questionTypesDesc = EXAM_TYPE_NAMES[examType] || '考试';
      if (questionTypes && questionTypes.length > 0) {
        questionTypesDesc += `，包含以下题型：${questionTypes.join('、')}`;
      }

      const userAfterCost = await consumePoint(c.env, {
        userId: authUserId,
        amount: 1,
        reason: 'exam_generate',
        metadata: {
          questionCount: Number.parseInt(questionCount, 10) || 15,
          mode: 'exam'
        }
      });
      consumedPoint = true;

      const exam = await generateExam(client, c.env, {
        version,
        grade,
        subject,
        topics: topic,
        examPoints: examPoint || topic,
        difficulty: Number.parseInt(difficulty, 10),
        questionTypes: questionTypesDesc,
        questionCount: Number.parseInt(questionCount, 10),
        difficultyPrompt,
        imageUrls
      });

      return c.json({
        ...exam,
        userPoints: userAfterCost.points
      });
    } catch (error) {
      if (consumedPoint && authUserId) {
        try {
          await refundPoint(c.env, {
            userId: authUserId,
            amount: 1,
            reason: 'generate_failed_refund',
            metadata: { reason: String(error.message || '') }
          });
        } catch (refundError) {
          console.error('积分回滚失败:', refundError.message);
        }
      }

      console.error('生成试卷失败:', error.message);
      const msg = String(error.message || '');
      const isClientError = /积分不足|缺少|参数|请选择|请先/.test(msg);
      return c.json({ error: `生成失败: ${msg}` }, isClientError ? 400 : 500);
    }
  });
}
