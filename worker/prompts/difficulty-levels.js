const DIFFICULTY_LEVELS = {
  1: { name: '基础识记', cognitive: '记忆', features: '直接考查概念、定义、公式，无变形，一步即可得出答案', steps: '1步', time: '30秒-1分钟/题', constraints: ['题目直接考查定义或公式','不需要任何推理或变形','答案可以直接从课本中找到','选择题干扰项与正确答案差异明显'] },
  2: { name: '简单理解', cognitive: '理解', features: '简单应用基本概念，需要一步简单计算或判断', steps: '1-2步', time: '1-2分钟/题', constraints: ['需要理解概念含义','一步简单计算即可','不涉及多个知识点结合','选择题干扰项有一定区分度'] },
  3: { name: '基础应用', cognitive: '应用', features: '套用公式或方法，2-3步计算，单一知识点应用', steps: '2-3步', time: '2-3分钟/题', constraints: ['需要选择并套用正确的公式','计算步骤2-3步','单一知识点的直接应用','题目条件明确，无需额外分析'] },
  4: { name: '熟练应用', cognitive: '应用', features: '需要选择合适方法，3-4步计算，可能涉及简单变形', steps: '3-4步', time: '3-5分钟/题', constraints: ['需要从多个方法中选择合适的','可能需要简单的公式变形','计算步骤3-4步','题目可能有一个小陷阱'] },
  5: { name: '综合应用', cognitive: '分析', features: '多知识点结合，需要分析题意，4-5步推理', steps: '4-5步', time: '5-8分钟/题', constraints: ['涉及2-3个知识点的结合','需要分析题目条件','可能需要画图辅助理解','选择题干扰项设置较为巧妙'] },
  6: { name: '灵活变通', cognitive: '分析', features: '题目有变形，需要转化思维，5-6步推理', steps: '5-6步', time: '8-10分钟/题', constraints: ['题目表述有变化，不是直接套公式','需要将问题转化为已知模型','可能需要构造辅助元素','需要较强的分析能力'] },
  7: { name: '深度分析', cognitive: '分析/评价', features: '多步骤推理，需要构建完整解题思路，6-8步', steps: '6-8步', time: '10-12分钟/题', constraints: ['需要构建完整的解题框架','涉及3-4个知识点的综合运用','可能需要分类讨论','需要较强的逻辑推理能力'] },
  8: { name: '综合创新', cognitive: '评价/创造', features: '跨章节综合，需要创造性思维，8-10步', steps: '8-10步', time: '12-15分钟/题', constraints: ['跨章节、跨知识点综合','需要创造性的解题方法','可能有多种解法','需要较强的数学建模能力'] },
  9: { name: '竞赛入门', cognitive: '创造', features: '需要巧妙方法或非常规思路，10+步', steps: '10+步', time: '15-20分钟/题', constraints: ['需要非常规的解题思路','可能需要引入辅助工具或方法','题目条件隐含，需要深度挖掘','接近竞赛初赛难度'] },
  10: { name: '竞赛难题', cognitive: '创造', features: '需要深厚功底和创新能力，高度综合', steps: '10+步，多层推理', time: '20+分钟/题', constraints: ['需要深厚的学科功底','需要高度创新的解题方法','题目可能需要构造反例或证明','竞赛决赛级别难度'] }
};

const GRADE_SUBJECT_MODIFIERS = {
  '小学一年级': { '数学': { baseComplexity: 'very_low', maxSteps: 2, topics: '10以内加减法' }, '语文': { baseComplexity: 'very_low', maxSteps: 1, topics: '拼音识字' } },
  '小学六年级': { '数学': { baseComplexity: 'low', maxSteps: 5, topics: '分数运算、比例' }, '语文': { baseComplexity: 'low', maxSteps: 3, topics: '阅读理解、写作' } },
  '初中三年级': { '数学': { baseComplexity: 'medium', maxSteps: 8, topics: '二次函数、圆' }, '物理': { baseComplexity: 'medium', maxSteps: 6, topics: '电学、力学综合' }, '化学': { baseComplexity: 'medium', maxSteps: 5, topics: '酸碱盐' } },
  '高中一年级': { '数学': { baseComplexity: 'medium_high', maxSteps: 10, topics: '函数、三角函数' }, '物理': { baseComplexity: 'medium_high', maxSteps: 8, topics: '牛顿运动定律' }, '化学': { baseComplexity: 'medium', maxSteps: 6, topics: '物质结构' } },
  '高中三年级': { '数学': { baseComplexity: 'high', maxSteps: 15, topics: '导数、圆锥曲线' }, '物理': { baseComplexity: 'high', maxSteps: 12, topics: '电磁感应综合' }, '化学': { baseComplexity: 'medium_high', maxSteps: 8, topics: '有机化学' } }
};

export function getDifficultyPrompt(difficulty, grade, subject) {
  const level = DIFFICULTY_LEVELS[difficulty];
  if (!level) return '';

  const modifier = GRADE_SUBJECT_MODIFIERS[grade]?.[subject] || {};

  return `
【难度要求 - 等级 ${difficulty}/10：${level.name}】
- 认知层次：${level.cognitive}
- 题目特征：${level.features}
- 解题步骤：${level.steps}
- 预计用时：${level.time}

【${grade}${subject}难度校准】
- 基础复杂度：${modifier.baseComplexity || 'medium'}
- 最大步骤数：${modifier.maxSteps || 6}
- 核心知识域：${modifier.topics || '综合'}

【难度控制细则】
${level.constraints.map(c => `- ${c}`).join('\n')}

【难度自检要求】
生成每道题后，请自我评估该题是否真正达到${difficulty}级难度。
如果难度偏低或偏高，请调整后重新生成。
确保10道题中，难度波动不超过±1级。`;
}
