const express = require('express');
const router = express.Router();
const {
  generateTopicSuggestions,
  generateExam,
  analyzeWrongQuestion,
  generateWrongQuestionPractice
} = require('../services/ai');
const {
  consumePoint,
  refundPoint
} = require('../services/account-store');
const { getDifficultyPrompt } = require('../prompts/difficulty-levels');

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
  const parsed = parseInt(value, 10);
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

/**
 * GET /api/exam/runtime-config
 * 获取前端运行所需的题型配置与上传限制（规则后端化）
 */
router.get('/runtime-config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(buildRuntimeConfig());
});

/**
 * POST /api/exam/suggest-topics
 * AI 生成知识点建议
 */
router.post('/suggest-topics', async (req, res) => {
  try {
    const { version, grade, subject, keyword, imageUrls = [] } = req.body;
    if (!keyword) {
      return res.status(400).json({ error: '请输入关键词' });
    }
    if (!Array.isArray(imageUrls)) {
      return res.status(400).json({ error: 'imageUrls 必须是数组' });
    }

    console.log(`[AI] 生成知识点建议: ${version} ${grade} ${subject} "${keyword}"`);
    const topics = await generateTopicSuggestions({ version, grade, subject, keyword, imageUrls });
    res.json({ topics });
  } catch (error) {
    console.error('生成知识点建议失败:', error.message);
    res.status(500).json({ error: '生成失败: ' + error.message });
  }
});

/**
 * POST /api/exam/analyze-wrong-question
 * AI 解析错题，提取知识点、考点、答案解析、是否含图
 */
router.post('/analyze-wrong-question', async (req, res) => {
  try {
    const {
      fileName = '',
      mimeType = '',
      previewImageUrl = '',
      extractedText = ''
    } = req.body;

    if (!previewImageUrl || typeof previewImageUrl !== 'string') {
      return res.status(400).json({ error: '缺少可识别的题目图片数据' });
    }

    if (!['image/png', 'image/jpeg', 'application/pdf'].includes(mimeType)) {
      return res.status(400).json({ error: '仅支持 PNG/JPG/PDF' });
    }

    const result = await analyzeWrongQuestion({
      fileName,
      mimeType,
      previewImageUrl,
      extractedText
    });

    res.json(result);
  } catch (error) {
    console.error('解析错题失败:', error.message);
    res.status(500).json({ error: '解析失败: ' + error.message });
  }
});

/**
 * POST /api/exam/generate
 * AI 生成试卷题目
 */
router.post('/generate', async (req, res) => {
  let consumedPoint = false;
  let authUserId = 0;
  try {
    authUserId = Number(req.authUser?.id || 0);
    if (!authUserId) {
      return res.status(401).json({ error: '请先登录账号后再使用' });
    }

    const hasPracticePayload = (
      req.body && (
        req.body.knowledgePoints !== undefined ||
        req.body.examPoints !== undefined ||
        req.body.sourceQuestionText !== undefined
      )
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
      } = req.body;

      const normalizedKnowledgePoints = normalizeTextList(knowledgePoints);
      const normalizedExamPoints = normalizeTextList(examPoints);
      const normalizedTypes = Array.isArray(questionTypes) && questionTypes.length > 0
        ? questionTypes.map((item) => String(item || '').trim()).filter(Boolean)
        : PRACTICE_TYPES;

      if (!normalizedKnowledgePoints.length && !normalizedExamPoints.length) {
        return res.status(400).json({ error: '缺少知识点或考点，请先上传错题并完成解析' });
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
        parseInt(questionCount, 10) || totalFromTypeCounts || normalizedTypes.length
      );

      const userAfterCost = await consumePoint({
        userId: authUserId,
        amount: 1,
        reason: 'practice_generate',
        metadata: {
          questionCount: resolvedQuestionCount,
          mode: 'practice'
        }
      });
      consumedPoint = true;

      const exam = await generateWrongQuestionPractice({
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

      return res.json({
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
    } = req.body;

    if (!grade || !subject || !topic) {
      return res.status(400).json({ error: '缺少必填参数: grade, subject, topic' });
    }
    if (!Array.isArray(imageUrls)) {
      return res.status(400).json({ error: 'imageUrls 必须是数组' });
    }

    const difficultyPrompt = getDifficultyPrompt(
      parseInt(difficulty, 10), grade, subject
    );

    let questionTypesDesc = EXAM_TYPE_NAMES[examType] || '考试';
    if (questionTypes && questionTypes.length > 0) {
      questionTypesDesc += `，包含以下题型：${questionTypes.join('、')}`;
    }

    const userAfterCost = await consumePoint({
      userId: authUserId,
      amount: 1,
      reason: 'exam_generate',
      metadata: {
        questionCount: parseInt(questionCount, 10) || 15,
        mode: 'exam'
      }
    });
    consumedPoint = true;

    console.log(`[AI] 生成试卷: ${version} ${grade} ${subject} "${topic}" 难度${difficulty} 题型[${questionTypes.join(',')}] 数量${questionCount}`);

    const exam = await generateExam({
      version,
      grade,
      subject,
      topics: topic,
      examPoints: examPoint || topic,
      difficulty: parseInt(difficulty, 10),
      questionTypes: questionTypesDesc,
      questionCount: parseInt(questionCount, 10),
      difficultyPrompt,
      imageUrls
    });

    res.json({
      ...exam,
      userPoints: userAfterCost.points
    });
  } catch (error) {
    if (consumedPoint && authUserId) {
      try {
        await refundPoint({
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
    res.status(isClientError ? 400 : 500).json({ error: '生成失败: ' + msg });
  }
});

module.exports = router;
