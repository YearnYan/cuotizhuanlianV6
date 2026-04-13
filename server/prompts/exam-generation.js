import { getDifficultyPrompt } from './difficulty-levels.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 加载图形约束规范缓存
const figureConstraintsCache = {};

function loadFigureConstraints(subject) {
  if (figureConstraintsCache[subject]) return figureConstraintsCache[subject];
  try {
    const filePath = join(__dirname, '../../docs/图形约束规范', `${subject}-图形约束规范.md`);
    const content = readFileSync(filePath, 'utf-8');
    figureConstraintsCache[subject] = content;
    return content;
  } catch (e) {
    return '暂无专属约束规范';
  }
}

const EXAM_TYPE_NAMES = {
  'quiz': '随堂小测', 'unit': '单元测试',
  'midterm': '期中考试', 'final': '期末考试', 'mock': '模拟考试'
};

/**
 * 组装完整的试题生成提示词
 */
export function assembleExamPrompt(params) {
  const {
    version, grade, subject, topic, examPoint,
    difficulty, examType, questionTypes
  } = params;

  const difficultyPrompt = getDifficultyPrompt(difficulty, grade, subject);
  const figureConstraints = loadFigureConstraints(subject);
  const examTypeName = EXAM_TYPE_NAMES[examType] || '考试';

  const totalScore = questionTypes.choice * 5
    + questionTypes.blank * 5
    + (100 - questionTypes.choice * 5 - questionTypes.blank * 5);

  return `你是一位资深的${grade}${subject}教师，精通${version}教材体系，拥有20年教学经验。

【出题任务】
请出一份关于"${topic}"的${examTypeName}试卷。
教材版本：${version}
考点：${examPoint || topic}

【教材版本约束】
- 严格遵循${version}教材的知识点体系和术语规范
- 题目内容必须与${version}教材的教学进度和难度匹配
- 不得出现其他版本教材特有的知识点或表述方式

${difficultyPrompt}

【题量要求】
1. 选择题：${questionTypes.choice}道（每题5分，共${questionTypes.choice * 5}分）
   - 4个选项（A、B、C、D），选项长度适中
   - 干扰项设置合理，有一定迷惑性
   - 选项之间不能有包含关系

2. 填空题：${questionTypes.blank}道（每题5分，共${questionTypes.blank * 5}分）
   - 每题1-2个空
   - 答案唯一或有限个
   - 题干必须完整清晰

3. 解答题：${questionTypes.qa}道（共${100 - questionTypes.choice * 5 - questionTypes.blank * 5}分）
   - 每题必须有完整题干和小问
   - 分值合理分配
   - 解题步骤要有层次

【数学公式格式 - 重要】
- 所有数学公式使用KaTeX语法
- 分数：\\frac{分子}{分母}
- 根号：\\sqrt{内容}
- 上标：x^{2}
- 三角函数：\\sin, \\cos, \\tan
- 希腊字母：\\alpha, \\beta, \\pi
- 向量：\\vec{a}
- 集合：\\{1,2,3\\}
- 不等式：\\leq, \\geq
- 化学方程式：\\ce{H2O}（mhchem语法）

【图形要求 - 极其重要】
根据科目特点，必须为每道题添加图形：

1. 数学题：每道题都必须包含图形
   - 几何题：必须有几何图形（三角形、圆、多边形等）
   - 函数题：必须有函数图像或坐标系
   - 代数题：必须有数轴、韦恩图或示意图

2. 物理题：每道题都必须包含图形
   - 力学题：必须有受力分析图或运动轨迹图
   - 电学题：必须有电路图
   - 光学题：必须有光路图

3. 化学题：每道题都必须包含图形
   - 必须有分子结构图、实验装置图或化学反应图

4. 其他科目：根据题目内容判断，如涉及图形、图表、示意图等，必须添加

图形格式：
{
  "figure": {
    "type": "图形类型（geometry/circuit/molecule/coordinate/timeline等）",
    "description": "详细的图形描述，必须具体到每个元素的位置、大小、关系",
    "params": {}
  }
}

图形描述必须足够详细，以便后端LaTeX渲染系统能准确生成。
禁止使用"如图所示"等模糊表述，必须具体说明图形内容。

【${subject}科目图形约束摘要】
${figureConstraints.substring(0, 500)}

【原创性约束】
- 每道题必须是原创的，不得直接照搬教材或真题
- 题目要有新意，避免套路化
- 题目之间不能重复考查同一个知识点的同一个角度

【质量约束】
- 题目表述必须清晰、准确、无歧义
- 答案必须唯一且正确
- 解析必须详细，包含解题步骤和知识点关联

【输出格式】
严格返回以下JSON格式，不要有任何其他文字：
{
  "title": "${grade}${subject} · ${examTypeName}",
  "questions": [
    {
      "type": "choice",
      "title": "一、选择题（本大题共${questionTypes.choice}小题，每小题5分，共${questionTypes.choice * 5}分）",
      "items": [
        {
          "index": 1,
          "stem": "题目内容（使用KaTeX语法）",
          "options": ["A. 选项1", "B. 选项2", "C. 选项3", "D. 选项4"],
          "figure": null
        }
      ]
    },
    {
      "type": "blank",
      "title": "二、填空题（本大题共${questionTypes.blank}小题，每小题5分，共${questionTypes.blank * 5}分）",
      "items": [
        { "index": ${questionTypes.choice + 1}, "stem": "题目内容______。" }
      ]
    },
    {
      "type": "qa",
      "title": "三、解答题（本大题共${questionTypes.qa}小题，共${100 - questionTypes.choice * 5 - questionTypes.blank * 5}分）",
      "items": [
        { "index": ${questionTypes.choice + questionTypes.blank + 1}, "stem": "（X分）完整的解答题内容" }
      ]
    }
  ],
  "answers": ["1. A [解析] 详细解析", "2. B [解析] 详细解析"]
}`;
}

export { EXAM_TYPE_NAMES };
