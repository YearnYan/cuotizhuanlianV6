const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// 缓存知识库数据
const knowledgeCache = {};

function loadKnowledgeBase(version) {
    if (knowledgeCache[version]) return knowledgeCache[version];
    try {
        const filePath = path.join(__dirname, '../../docs/教材知识点', `${version}.json`);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        knowledgeCache[version] = data;
        return data;
    } catch (e) {
        console.error(`加载知识库失败: ${version}`, e.message);
        return null;
    }
}

// 获取可用教材版本列表
router.get('/versions', (req, res) => {
    try {
        const knowledgeDir = path.join(__dirname, '../../docs/教材知识点');
        const files = fs.readdirSync(knowledgeDir)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace('.json', ''));
        res.json({ versions: files });
    } catch (e) {
        res.json({ versions: ['人教版', '苏教版', '北师大版', '鲁教版'] });
    }
});

// 获取指定版本、年级、科目的知识点（新格式：知识点-考点映射）
router.get('/topics', (req, res) => {
    const { version, grade, subject } = req.query;
    if (!version || !grade || !subject) {
        return res.status(400).json({ error: '缺少参数: version, grade, subject' });
    }

    const data = loadKnowledgeBase(version);
    if (!data) {
        return res.json({ topics: [] });
    }

    // 尝试多种数据结构
    let gradeData = data[version]?.[grade] || data[grade];
    if (!gradeData || !gradeData[subject]) {
        return res.json({ topics: [] });
    }

    const subjectData = gradeData[subject];
    const topicsData = subjectData['知识点'] || subjectData.topics || [];

    // 返回新格式：每个知识点包含name和examPoints
    res.json({
        topics: topicsData
    });
});

// 获取指定知识点的考点（用于联动）
router.get('/exam-points', (req, res) => {
    const { version, grade, subject, topic } = req.query;
    if (!version || !grade || !subject || !topic) {
        return res.status(400).json({ error: '缺少参数: version, grade, subject, topic' });
    }

    const data = loadKnowledgeBase(version);
    if (!data) {
        return res.json({ examPoints: [] });
    }

    let gradeData = data[version]?.[grade] || data[grade];
    if (!gradeData || !gradeData[subject]) {
        return res.json({ examPoints: [] });
    }

    const subjectData = gradeData[subject];
    const topicsData = subjectData['知识点'] || subjectData.topics || [];

    // 查找匹配的知识点
    const matchedTopic = topicsData.find(t => t.name === topic);

    res.json({
        examPoints: matchedTopic ? matchedTopic.examPoints : []
    });
});

// 获取题型知识库（支持按学段、科目、年级过滤）
router.get('/question-types', (req, res) => {
    const { grade, subject } = req.query;
    try {
        const filePath = path.join(__dirname, '../../docs/教材知识点/题型知识库.json');
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

        if (!grade || !subject) {
            return res.json(data);
        }

        // 从年级名称推断学段和年级编号
        let stage = '', gradeNum = '';
        if (grade.startsWith('小学')) {
            stage = '小学';
            gradeNum = grade.replace('小学', '').replace('年级', '');
        } else if (grade.startsWith('初中')) {
            stage = '初中';
            gradeNum = grade.replace('初中', '').replace('年级', '');
        } else if (grade.startsWith('高中')) {
            stage = '高中';
            gradeNum = grade.replace('高中', '').replace('年级', '');
        }

        const stageData = data[stage];
        if (!stageData || !stageData[subject]) {
            // 兜底：返回通用题型
            return res.json({ questionTypes: getDefaultQuestionTypes(stage, subject) });
        }

        const subjectTypes = stageData[subject]['题型'] || [];
        // 按年级过滤
        const filtered = subjectTypes
            .filter(t => !t.grades || t.grades.includes(gradeNum))
            .map(t => t.name);

        if (filtered.length === 0) {
            return res.json({ questionTypes: getDefaultQuestionTypes(stage, subject) });
        }

        res.json({ questionTypes: filtered });
    } catch (e) {
        console.error('加载题型知识库失败:', e.message);
        res.json({ questionTypes: ['选择题', '填空题', '解答题'] });
    }
});

// 兜底题型方案
function getDefaultQuestionTypes(stage, subject) {
    if (stage === '小学') return ['选择题', '填空题', '判断题', '应用题'];
    if (stage === '初中') return ['选择题', '填空题', '解答题'];
    if (stage === '高中') return ['选择题', '填空题', '解答题'];
    return ['选择题', '填空题', '解答题'];
}

module.exports = router;
