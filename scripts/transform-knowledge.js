/**
 * 知识点-考点关联转换脚本 v3
 * 策略：优先使用原始考点，通过多维度匹配确保合理分配
 */

const fs = require('fs');
const path = require('path');

const KNOWLEDGE_DIR = path.join(__dirname, '../docs/教材知识点');

function relevanceScore(topic, examPoint) {
  const t = topic.replace(/[（(][^）)]*[）)]/g, '');
  const e = examPoint;
  let score = 0;

  // 1. 直接包含关系（最强信号）
  const tCore = t.split('：')[0].trim();
  const tDetail = t.split('：').slice(1).join('').trim();
  if (tCore.length >= 2 && e.includes(tCore)) score += 20;
  if (e.length >= 2 && tCore.includes(e)) score += 18;
  if (tDetail && tDetail.length >= 2 && e.includes(tDetail)) score += 15;
  if (tDetail && e.length >= 2 && tDetail.includes(e)) score += 12;

  // 2. 关键词交叉匹配
  const tWords = t.split(/[：:，,、；;·\-—\s《》""''（()）]+/).filter(w => w.length >= 2);
  const eWords = e.split(/[：:，,、；;·\-—\s《》""''（()）]+/).filter(w => w.length >= 2);

  for (const tw of tWords) {
    for (const ew of eWords) {
      if (tw === ew) score += 8;
      else if (tw.length >= 2 && ew.length >= 2) {
        if (tw.includes(ew)) score += 4;
        if (ew.includes(tw)) score += 4;
      }
    }
  }

  // 3. 学科特定匹配规则
  const mathPairs = [
    [/加|减|口算/, /加|减|口算|计算/],
    [/乘法|乘/, /乘法|乘|口诀/],
    [/除法|除/, /除法|除|求商/],
    [/图形|几何|三角|圆|平行|梯形/, /图形|几何|辨认|分类|面积|周长/],
    [/方程/, /方程|解法/],
    [/函数/, /函数|图像|性质/],
    [/数列/, /数列|求和/],
    [/概率|统计/, /概率|统计|数据/],
    [/钟表|时间|时分秒/, /时间|钟表|认读/],
    [/位置|方向/, /位置|方向|判断/],
    [/分数/, /分数/],
    [/小数/, /小数/],
    [/面积/, /面积/],
    [/周长/, /周长/],
    [/体积/, /体积/],
    [/角/, /角|度量/],
    [/单位|换算|厘米|米|千克/, /单位|换算/],
    [/应用题|实际问题/, /应用|实际/],
    [/规律/, /规律/],
    [/人民币/, /人民币/],
  ];

  for (const [tReg, eReg] of mathPairs) {
    if (tReg.test(t) && eReg.test(e)) score += 6;
  }

  const cnPairs = [
    [/拼音|声母|韵母/, /拼音|拼读|声调|声母|韵母/],
    [/识字|写字|生字/, /生字|认读|书写|识字/],
    [/笔画|笔顺/, /笔顺|笔画/],
    [/偏旁|部首/, /偏旁|部首/],
    [/词语|词汇/, /词语|词汇|运用/],
    [/句子|句式|句型/, /句子|句式|句型|转换/],
    [/古诗|诗词/, /古诗|诗词|默写|鉴赏|背诵/],
    [/阅读|课文/, /阅读|理解|课文/],
    [/写话|习作|写作|作文/, /写话|习作|写作|作文/],
    [/口语|交际/, /口语|交际/],
    [/标点/, /标点/],
    [/修辞/, /修辞/],
    [/文言文/, /文言文|翻译/],
    [/名著/, /名著/],
    [/病句/, /病句/],
    [/查字典/, /查字典/],
  ];

  for (const [tReg, eReg] of cnPairs) {
    if (tReg.test(t) && eReg.test(e)) score += 6;
  }

  const sciPairs = [
    [/力|牛顿|运动/, /力|受力|牛顿|运动/],
    [/电|电路|欧姆/, /电|电路|欧姆/],
    [/光|透镜|折射/, /光|透镜|折射|反射/],
    [/压强|浮力/, /压强|浮力/],
    [/功|能|机械能/, /功|功率|能/],
    [/磁|电磁/, /磁|电磁/],
    [/内能|热/, /内能|热/],
    [/细胞/, /细胞/],
    [/光合|呼吸/, /光合|呼吸/],
    [/遗传|基因/, /遗传|基因/],
    [/生态/, /生态/],
    [/离子|氧化还原/, /离子|氧化还原/],
    [/酸碱盐/, /酸碱盐/],
    [/有机/, /有机/],
    [/实验/, /实验/],
    [/速度/, /速度/],
    [/声/, /声/],
    [/物态变化/, /物态/],
    [/杠杆|滑轮/, /杠杆|滑轮/],
    [/机械运动/, /速度|运动/],
    [/简单机械/, /杠杆|滑轮|机械/],
    [/集合/, /集合/],
    [/导数/, /导数/],
    [/向量/, /向量/],
    [/数列/, /数列/],
    [/排列|组合/, /排列|组合/],
    [/二项式/, /二项式/],
    [/椭圆|双曲线|抛物线|圆锥曲线/, /圆锥曲线|椭圆|双曲线|抛物线/],
    [/立体几何/, /立体几何/],
    [/解析几何/, /解析几何/],
  ];

  for (const [tReg, eReg] of sciPairs) {
    if (tReg.test(t) && eReg.test(e)) score += 6;
  }

  return score;
}

function transformSubjectData(knowledgePoints, examPoints) {
  if (!knowledgePoints || knowledgePoints.length === 0) return [];
  if (!examPoints || examPoints.length === 0) {
    return knowledgePoints.map(name => ({
      name,
      examPoints: generateDefaultEPs(name)
    }));
  }

  // 构建得分矩阵：每个考点对每个知识点的相关性
  const matrix = [];
  for (let ei = 0; ei < examPoints.length; ei++) {
    const row = [];
    for (let ti = 0; ti < knowledgePoints.length; ti++) {
      row.push(relevanceScore(knowledgePoints[ti], examPoints[ei]));
    }
    matrix.push(row);
  }

  // 初始化结果
  const result = knowledgePoints.map(name => ({ name, examPoints: [] }));

  // 分配考点：每个考点分配给得分最高的1-3个知识点
  for (let ei = 0; ei < examPoints.length; ei++) {
    const scores = matrix[ei].map((score, ti) => ({ ti, score }));
    scores.sort((a, b) => b.score - a.score);

    const bestScore = scores[0].score;
    if (bestScore > 0) {
      // 分配给最佳匹配
      result[scores[0].ti].examPoints.push(examPoints[ei]);
      // 也分配给其他高分匹配（>= 50%最高分且 > 3分）
      for (let i = 1; i < scores.length; i++) {
        if (scores[i].score >= bestScore * 0.5 && scores[i].score > 3) {
          result[scores[i].ti].examPoints.push(examPoints[ei]);
        }
      }
    } else {
      // 没有匹配，分配给最后一个知识点（通常是综合类）
      result[result.length - 1].examPoints.push(examPoints[ei]);
    }
  }

  // 去重
  for (const item of result) {
    item.examPoints = [...new Set(item.examPoints)];
  }

  // 为没有考点的知识点生成默认考点
  for (const item of result) {
    if (item.examPoints.length === 0) {
      item.examPoints = generateDefaultEPs(item.name);
    }
  }

  return result;
}

function generateDefaultEPs(name) {
  const core = name.split('：')[0].replace(/[（(][^）)]*[）)]/g, '').trim();
  const detail = name.split('：').slice(1).join('').trim();

  // 根据知识点内容生成合理的考点
  if (/加|减|乘|除|运算|计算/.test(name)) return [`${core}计算`, `${core}应用题`];
  if (/图形|几何|三角|圆|平行/.test(name)) return [`${core}辨认与性质`, `${core}计算`];
  if (/方程|不等式/.test(name)) return [`${core}解法`, `${core}应用`];
  if (/函数/.test(name)) return [`${core}图像与性质`, `${core}应用`];
  if (/拼音|声母|韵母/.test(name)) return ['拼音拼读', '声调标注'];
  if (/识字|写字/.test(name)) return ['生字认读', '规范书写'];
  if (/古诗|诗词/.test(name)) return ['古诗背诵默写', '诗词理解'];
  if (/阅读|课文/.test(name)) return ['课文内容理解', '阅读理解'];
  if (/写话|习作|写作/.test(name)) return ['写作能力', '语言表达'];
  if (/实验/.test(name)) return ['实验操作', '实验探究'];
  if (/统计|概率|数据/.test(name)) return [`${core}分析`, `${core}计算`];

  return [`${core}的理解`, `${core}的应用`];
}

function transformVersion(versionData) {
  const result = {};
  for (const [grade, subjects] of Object.entries(versionData)) {
    result[grade] = {};
    for (const [subject, data] of Object.entries(subjects)) {
      const topics = data['知识点'] || data.topics || [];
      const examPoints = data['考点'] || data.examPoints || [];
      if (topics.length > 0 && typeof topics[0] === 'object') {
        result[grade][subject] = { '知识点': topics };
        continue;
      }
      result[grade][subject] = {
        '知识点': transformSubjectData(topics, examPoints)
      };
    }
  }
  return result;
}

function main() {
  const versions = ['人教版', '苏教版', '北师大版', '鲁教版'];
  for (const version of versions) {
    const filePath = path.join(KNOWLEDGE_DIR, `${version}.json`);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const versionData = raw[version];
      if (!versionData) { console.log(`跳过 ${version}`); continue; }

      const transformed = { [version]: transformVersion(versionData) };
      fs.writeFileSync(filePath, JSON.stringify(transformed, null, 2), 'utf-8');

      // 统计
      let totalTopics = 0, totalEPs = 0, emptyCount = 0;
      for (const subjects of Object.values(transformed[version])) {
        for (const data of Object.values(subjects)) {
          for (const t of data['知识点']) {
            totalTopics++;
            totalEPs += t.examPoints.length;
            if (t.examPoints.length === 0) emptyCount++;
          }
        }
      }
      console.log(`✓ ${version}: ${totalTopics} 知识点, ${totalEPs} 考点映射, ${emptyCount} 空考点`);

      // 抽样输出验证
      const sample = transformed[version]['小学一年级']?.['数学']?.['知识点'];
      if (sample) {
        console.log(`  [抽样] 小学一年级数学:`);
        sample.slice(0, 3).forEach(t => {
          console.log(`    ${t.name} -> [${t.examPoints.join(', ')}]`);
        });
      }
    } catch (e) {
      console.error(`处理 ${version} 失败:`, e.message);
    }
  }
}

main();
