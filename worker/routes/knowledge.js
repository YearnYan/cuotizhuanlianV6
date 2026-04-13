// Import knowledge base JSON files directly (bundled by wrangler/esbuild)
import renjiao from '../../docs/教材知识点/人教版.json';
import beishida from '../../docs/教材知识点/北师大版.json';
import sujiao from '../../docs/教材知识点/苏教版.json';
import lujiao from '../../docs/教材知识点/鲁教版.json';
import questionTypesData from '../../docs/教材知识点/题型知识库.json';

const knowledgeBases = {
  '人教版': renjiao,
  '北师大版': beishida,
  '苏教版': sujiao,
  '鲁教版': lujiao,
};

const AVAILABLE_VERSIONS = Object.keys(knowledgeBases);

function loadKnowledgeBase(version) {
  return knowledgeBases[version] || null;
}

function getDefaultQuestionTypes(stage) {
  if (stage === '小学') return ['选择题', '填空题', '判断题', '应用题'];
  return ['选择题', '填空题', '解答题'];
}

export function knowledgeRoutes(app) {
  // GET /versions
  app.get('/versions', (c) => {
    return c.json({ versions: AVAILABLE_VERSIONS });
  });

  // GET /topics
  app.get('/topics', (c) => {
    const version = c.req.query('version');
    const grade = c.req.query('grade');
    const subject = c.req.query('subject');
    if (!version || !grade || !subject) {
      return c.json({ error: '缺少参数: version, grade, subject' }, 400);
    }

    const data = loadKnowledgeBase(version);
    if (!data) return c.json({ topics: [] });

    const gradeData = data[version]?.[grade] || data[grade];
    if (!gradeData || !gradeData[subject]) return c.json({ topics: [] });

    const subjectData = gradeData[subject];
    const topicsData = subjectData['知识点'] || subjectData.topics || [];
    return c.json({ topics: topicsData });
  });

  // GET /exam-points
  app.get('/exam-points', (c) => {
    const version = c.req.query('version');
    const grade = c.req.query('grade');
    const subject = c.req.query('subject');
    const topic = c.req.query('topic');
    if (!version || !grade || !subject || !topic) {
      return c.json({ error: '缺少参数: version, grade, subject, topic' }, 400);
    }

    const data = loadKnowledgeBase(version);
    if (!data) return c.json({ examPoints: [] });

    const gradeData = data[version]?.[grade] || data[grade];
    if (!gradeData || !gradeData[subject]) return c.json({ examPoints: [] });

    const subjectData = gradeData[subject];
    const topicsData = subjectData['知识点'] || subjectData.topics || [];
    const matchedTopic = topicsData.find(t => t.name === topic);
    return c.json({ examPoints: matchedTopic ? matchedTopic.examPoints : [] });
  });

  // GET /question-types
  app.get('/question-types', (c) => {
    const grade = c.req.query('grade');
    const subject = c.req.query('subject');

    if (!grade || !subject) return c.json(questionTypesData);

    let stage = '', gradeNum = '';
    if (grade.startsWith('小学')) { stage = '小学'; gradeNum = grade.replace('小学', '').replace('年级', ''); }
    else if (grade.startsWith('初中')) { stage = '初中'; gradeNum = grade.replace('初中', '').replace('年级', ''); }
    else if (grade.startsWith('高中')) { stage = '高中'; gradeNum = grade.replace('高中', '').replace('年级', ''); }

    const stageData = questionTypesData[stage];
    if (!stageData || !stageData[subject]) {
      return c.json({ questionTypes: getDefaultQuestionTypes(stage) });
    }

    const subjectTypes = stageData[subject]['题型'] || [];
    const filtered = subjectTypes
      .filter(t => !t.grades || t.grades.includes(gradeNum))
      .map(t => t.name);

    if (filtered.length === 0) {
      return c.json({ questionTypes: getDefaultQuestionTypes(stage) });
    }
    return c.json({ questionTypes: filtered });
  });
}
