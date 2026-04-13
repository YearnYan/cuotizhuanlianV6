// 赛博出卷机 - 前端应用
const API_BASE = '/api';

const state = {
    generatedQuestions: [],
    selectedQuestions: new Set(),
    currentExamData: null,
    mode: 'select',
    figureCache: new Map(), // 缓存已生成的SVG图形
    topicsData: [] // 缓存当前科目的知识点-考点映射数据
};

const DIFFICULTY_NAMES = {
    1: '基础识记', 2: '简单理解', 3: '基础应用', 4: '熟练应用',
    5: '综合应用', 6: '灵活变通', 7: '深度分析', 8: '综合创新',
    9: '竞赛入门', 10: '竞赛难题'
};

document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    onConfigChange();
    initDifficultyBar();
    updateDifficultyDisplay();

    // 标题编辑提示：点击标题后隐藏提示
    const paperTitle = document.getElementById('paperTitle');
    const titleHint = document.getElementById('titleEditHint');
    if (paperTitle && titleHint) {
        paperTitle.addEventListener('focus', () => { titleHint.style.opacity = '0'; });
        paperTitle.addEventListener('blur', () => { titleHint.style.display = 'none'; });
    }
});

async function onConfigChange() {
    const version = document.getElementById('version').value;
    const grade = document.getElementById('grade').value;
    const subject = document.getElementById('subject').value;

    try {
        // 并行加载知识点和题型
        const [topicsResp, typesResp] = await Promise.all([
            fetch(`${API_BASE}/knowledge/topics?version=${encodeURIComponent(version)}&grade=${encodeURIComponent(grade)}&subject=${encodeURIComponent(subject)}`),
            fetch(`${API_BASE}/knowledge/question-types?grade=${encodeURIComponent(grade)}&subject=${encodeURIComponent(subject)}`)
        ]);

        const topicsData = await topicsResp.json();
        const typesData = await typesResp.json();

        state.topicsData = topicsData.topics || [];
        populateTopics(state.topicsData);
        populateExamPoints([]);

        // 加载题型多选
        populateQuestionTypes(typesData.questionTypes || []);
    } catch (e) {
        console.error('加载配置失败:', e);
        state.topicsData = [];
        populateTopics([]);
        populateExamPoints([]);
        populateQuestionTypes(['选择题', '填空题', '解答题']);
    }
    saveSettings();
}

function populateTopics(topics) {
    const sel = document.getElementById('topicSelect');
    sel.innerHTML = '<option value="">-- 请选择知识点 --</option>';
    if (!topics || topics.length === 0) {
        sel.innerHTML = '<option value="">-- 暂无预设知识点，请自定义输入 --</option>';
    } else {
        topics.forEach(t => {
            const opt = document.createElement('option');
            const name = typeof t === 'string' ? t : t.name;
            opt.value = name;
            opt.textContent = name;
            sel.appendChild(opt);
        });
    }
    // 添加"手动输入知识点"选项
    const manualOpt = document.createElement('option');
    manualOpt.value = '__manual__';
    manualOpt.textContent = '手动输入知识点（没找到？自己填）✎';
    sel.appendChild(manualOpt);
}

function onTopicChange() {
    const sel = document.getElementById('topicSelect');
    const topicName = sel.value;

    // 隐藏手动输入框（如果之前显示了）
    hideManualInput('topic');

    if (topicName === '__manual__') {
        showManualInput('topic');
        populateExamPoints([]);
        return;
    }

    if (!topicName) {
        populateExamPoints([]);
        return;
    }

    // 从缓存的知识点数据中查找对应的考点
    const matched = state.topicsData.find(t =>
        (typeof t === 'string' ? t : t.name) === topicName
    );

    if (matched && typeof matched === 'object' && matched.examPoints) {
        populateExamPoints(matched.examPoints);
    } else {
        populateExamPoints([]);
    }
}

function populateExamPoints(points) {
    const sel = document.getElementById('examPointSelect');
    // 隐藏手动输入框
    hideManualInput('examPoint');

    if (!points || points.length === 0) {
        sel.innerHTML = '<option value="">-- 请先选择知识点 --</option>';
    } else {
        sel.innerHTML = '<option value="">-- 请选择考点 --</option>';
        points.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p; opt.textContent = p;
            sel.appendChild(opt);
        });
    }
    // 添加"手动输入考点"选项
    const manualOpt = document.createElement('option');
    manualOpt.value = '__manual__';
    manualOpt.textContent = '手动输入考点（没找到？自己填）✎';
    sel.appendChild(manualOpt);
}

function onExamPointChange() {
    const sel = document.getElementById('examPointSelect');
    const value = sel.value;

    hideManualInput('examPoint');

    if (value === '__manual__') {
        showManualInput('examPoint');
    }
}

function showManualInput(type) {
    const selectId = type === 'topic' ? 'topicSelect' : 'examPointSelect';
    const sel = document.getElementById(selectId);
    const parent = sel.parentElement;

    // 检查是否已存在输入框
    let inputDiv = parent.querySelector('.manual-input-wrapper');
    if (inputDiv) return;

    // 创建输入框容器
    inputDiv = document.createElement('div');
    inputDiv.className = 'manual-input-wrapper';
    inputDiv.style.cssText = 'margin-top:8px;display:flex;gap:8px;align-items:center';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = type === 'topic' ? 'manualTopicInput' : 'manualExamPointInput';
    input.placeholder = type === 'topic' ? '请输入知识点' : '请输入考点';
    input.style.cssText = 'flex:1;padding:8px;background:#0a192f;border:1px solid #233554;color:#e6f1ff;border-radius:2px;font-size:14px';

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = '确定';
    confirmBtn.style.cssText = 'padding:8px 16px;background:#64ffda;color:#0a192f;border:none;border-radius:2px;cursor:pointer;font-weight:bold;font-size:14px';
    confirmBtn.onclick = () => confirmManualInput(type);

    inputDiv.appendChild(input);
    inputDiv.appendChild(confirmBtn);
    parent.appendChild(inputDiv);

    input.focus();

    // 回车键确认
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') confirmManualInput(type);
    });
}

function hideManualInput(type) {
    const selectId = type === 'topic' ? 'topicSelect' : 'examPointSelect';
    const sel = document.getElementById(selectId);
    const parent = sel.parentElement;
    const inputDiv = parent.querySelector('.manual-input-wrapper');
    if (inputDiv) inputDiv.remove();
}

function confirmManualInput(type) {
    const inputId = type === 'topic' ? 'manualTopicInput' : 'manualExamPointInput';
    const selectId = type === 'topic' ? 'topicSelect' : 'examPointSelect';
    const input = document.getElementById(inputId);
    const sel = document.getElementById(selectId);

    const value = input.value.trim();
    if (!value) {
        alert('请输入内容');
        return;
    }

    // 移除"手动输入"选项
    const manualOpt = sel.querySelector('option[value="__manual__"]');
    if (manualOpt) manualOpt.remove();

    // 添加用户输入的选项并选中
    const newOpt = document.createElement('option');
    newOpt.value = value;
    newOpt.textContent = value + ' (自定义)';
    newOpt.selected = true;
    sel.appendChild(newOpt);

    // 重新添加"手动输入"选项到最后
    const manualOptNew = document.createElement('option');
    manualOptNew.value = '__manual__';
    manualOptNew.textContent = type === 'topic' ? '手动输入知识点（没找到？自己填）✎' : '手动输入考点（没找到？自己填）✎';
    sel.appendChild(manualOptNew);

    // 隐藏输入框
    hideManualInput(type);

    // 如果是知识点，清空考点选择
    if (type === 'topic') {
        populateExamPoints([]);
    }
}

// 题型多选
function populateQuestionTypes(types) {
    const container = document.getElementById('questionTypeContainer');
    if (!types || types.length === 0) {
        container.innerHTML = '<span style="color:#8892b0;font-size:12px">暂无可用题型</span>';
        return;
    }
    container.innerHTML = '';
    types.forEach(type => {
        const tag = document.createElement('span');
        tag.className = 'qtype-tag active'; // 默认全选
        tag.textContent = type;
        tag.dataset.type = type;
        tag.onclick = () => {
            tag.classList.toggle('active');
            saveSettings();
        };
        container.appendChild(tag);
    });
}

function getSelectedQuestionTypes() {
    const tags = document.querySelectorAll('#questionTypeContainer .qtype-tag.active');
    return Array.from(tags).map(t => t.dataset.type);
}

// 题目数量
function updateQuestionCount() {
    const val = document.getElementById('questionCount').value;
    document.getElementById('questionCountInput').value = val;
    saveSettings();
}

function syncQuestionCount(input) {
    let val = parseInt(input.value) || 15;
    val = Math.max(5, Math.min(50, val));
    input.value = val;
    document.getElementById('questionCount').value = val;
    saveSettings();
}

function initDifficultyBar() {
    const bar = document.getElementById('difficultyBar');
    bar.innerHTML = '';
    for (let i = 1; i <= 10; i++) {
        const seg = document.createElement('div');
        seg.className = 'seg';
        seg.dataset.level = i;
        bar.appendChild(seg);
    }
}

function updateDifficultyDisplay() {
    const val = parseInt(document.getElementById('difficulty').value);
    document.getElementById('difficultyValue').textContent = val;
    document.getElementById('difficultyLabel').textContent = DIFFICULTY_NAMES[val] || '';

    const segs = document.querySelectorAll('.difficulty-bar .seg');
    segs.forEach(seg => {
        const level = parseInt(seg.dataset.level);
        seg.className = 'seg';
        if (level <= val) {
            seg.classList.add('on');
            if (level >= 8) seg.classList.add('danger');
            else if (level >= 6) seg.classList.add('warn');
        }
    });
    saveSettings();
}

function getSelectedTopic() {
    const value = document.getElementById('topicSelect').value || '';
    return value === '__manual__' ? '' : value;
}

function getSelectedExamPoint() {
    const value = document.getElementById('examPointSelect').value || '';
    return value === '__manual__' ? '' : value;
}

async function generateExam() {
    const topic = getSelectedTopic();
    if (!topic) { alert('请选择或输入知识点！'); return; }

    const loadingEl = document.getElementById('loading');
    const loadingTitle = document.getElementById('loadingTitle');
    const loadingSubtitle = document.getElementById('loadingSubtitle');

    // 动态加载提示文案
    const loadingMessages = [
        { title: 'AI GENERATING QUESTIONS...', subtitle: '正在分析知识点结构...' },
        { title: 'AI GENERATING QUESTIONS...', subtitle: '正在构建题目框架...' },
        { title: 'AI GENERATING QUESTIONS...', subtitle: '正在生成题目内容...' },
        { title: 'AI GENERATING QUESTIONS...', subtitle: '正在优化题目难度...' },
        { title: 'AI GENERATING QUESTIONS...', subtitle: '即将完成，请稍候...' }
    ];

    let messageIndex = 0;
    loadingEl.style.display = 'flex';

    // 每2秒切换一次提示文案
    const messageInterval = setInterval(() => {
        messageIndex = (messageIndex + 1) % loadingMessages.length;
        if (loadingTitle) loadingTitle.textContent = loadingMessages[messageIndex].title;
        if (loadingSubtitle) loadingSubtitle.textContent = loadingMessages[messageIndex].subtitle;
    }, 2000);

    switchToSelectMode();

    try {
        const resp = await fetch(`${API_BASE}/exam/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                version: document.getElementById('version').value,
                grade: document.getElementById('grade').value,
                subject: document.getElementById('subject').value,
                topic, examPoint: getSelectedExamPoint(),
                difficulty: parseInt(document.getElementById('difficulty').value),
                examType: document.getElementById('examType').value,
                questionTypes: getSelectedQuestionTypes(),
                questionCount: parseInt(document.getElementById('questionCountInput').value) || 15
            })
        });

        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({ error: '服务器错误' }));
            alert('生成失败: ' + (errData.error || '未知错误'));
            clearInterval(messageInterval);
            loadingEl.style.display = 'none';
            return;
        }

        const data = await resp.json();

        // 检查是否有有效的试卷数据
        if (data.questions && Array.isArray(data.questions) && data.questions.length > 0) {
            state.currentExamData = data;
            renderQuestionCards(data);
        } else if (data.error) {
            alert('生成失败: ' + data.error);
        } else {
            alert('生成的试卷数据格式不正确，请重试');
        }
    } catch (e) {
        console.error('生成试卷异常:', e);
        alert('生成失败，请重试: ' + e.message);
    }
    clearInterval(messageInterval);
    loadingEl.style.display = 'none';
}

function renderQuestionCards(data) {
    const container = document.getElementById('selectMode');
    const composeBar = document.getElementById('composeBar');
    let html = '';
    let globalIndex = 0;

    state.generatedQuestions = [];
    state.selectedQuestions.clear();

    if (data.questions && Array.isArray(data.questions)) {
        for (const group of data.questions) {
            if (!group || !group.items) continue;
            html += `<div class="group-header">${group.title || ''}</div>`;
            for (const item of group.items) {
                if (!item) continue;
                const idx = globalIndex++;
                state.generatedQuestions.push({ ...item, groupType: group.type, groupTitle: group.title });

                html += `<div class="question-card" data-idx="${idx}" onclick="toggleQuestion(${idx})">
                    <div class="select-check">✓</div>
                    <div class="q-stem">${item.index || ''}. ${item.stem || ''}</div>`;

                if (group.type === 'choice' && item.options) {
                    html += `<div class="q-options">${item.options.filter(o => o).map(o => `<div class="q-option">${o}</div>`).join('')}</div>`;
                }

                if (item.figure) {
                    const figId = `fig_${idx}_${Date.now()}`;
                    const desc = typeof item.figure === 'string' ? item.figure : (item.figure.description || '');
                    html += `<div class="q-figure" id="${figId}" style="min-height:60px;border:1px dashed #ddd;padding:10px;text-align:center;border-radius:4px;background:#fafafa">
                        <span style="color:#999;font-size:12px">图形加载中...</span>
                    </div>`;
                    // 记录需要异步加载的图形，带上题干用于精确渲染
                    if (!state.pendingFigures) state.pendingFigures = [];
                    state.pendingFigures.push({
                        id: figId,
                        qIdx: idx,
                        figure: item.figure,
                        stem: item.stem || '',
                        subject: document.getElementById('subject').value
                    });
                }
                html += `</div>`;
            }
        }
    }

    container.innerHTML = html;
    composeBar.style.display = 'flex';
    updateSelectedCount();

    // 异步加载图形（不阻塞主内容显示）
    loadFiguresAsync();
}

async function loadFiguresAsync() {
    if (!state.pendingFigures || state.pendingFigures.length === 0) return;

    const figures = state.pendingFigures;
    state.pendingFigures = [];

    console.log(`[图形] 开始加载 ${figures.length} 个图形`);

    // 策略：并行批量渲染，每批最多5个
    const batchSize = 5;
    const batches = [];
    for (let i = 0; i < figures.length; i += batchSize) {
        batches.push(figures.slice(i, i + batchSize));
    }

    // 并行处理所有批次
    const batchPromises = batches.map((batch, batchIdx) =>
        loadBatch(batch, batchIdx, batches.length)
    );

    await Promise.all(batchPromises);
    console.log(`[图形] 全部加载完成`);
}

async function loadBatch(batch, batchIdx, totalBatches) {
    const batchData = batch.map(fig => {
        const desc = typeof fig.figure === 'string'
            ? fig.figure
            : (fig.figure.description || fig.figure.code || '');
        return {
            id: fig.id,
            description: desc,
            stem: fig.stem || '',
            tikzCode: fig.figure.code || null,
            subject: fig.subject
        };
    });

    try {
        const resp = await fetch(`${API_BASE}/render/figures-batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ figures: batchData })
        });

        const data = await resp.json();
        if (data.results) {
            // 收集失败的图形，准备重试
            const failedFigures = [];

            data.results.forEach(result => {
                const el = document.getElementById(result.id);
                if (!el) return;

                const fig = batch.find(f => f.id === result.id);

                if (result.svg) {
                    el.innerHTML = result.svg;
                    el.style.border = 'none';
                    el.style.background = 'transparent';

                    if (fig && fig.qIdx !== undefined) {
                        state.figureCache.set(fig.qIdx, result.svg);
                    }
                } else {
                    // 图形生成失败，记录下来准备重试
                    failedFigures.push(fig);
                    el.innerHTML = '<span style="color:#999;font-size:12px">图形重试中...</span>';
                }
            });

            // 对失败的图形进行单独重试
            if (failedFigures.length > 0) {
                await retryFailedFigures(failedFigures);
            }
        }
        console.log(`[图形] 批次 ${batchIdx + 1}/${totalBatches} 完成`);
    } catch (e) {
        console.error(`[图形] 批次 ${batchIdx + 1} 失败:`, e);
        // 网络错误时隐藏所有图形区域
        batch.forEach(fig => {
            const el = document.getElementById(fig.id);
            if (el) el.style.display = 'none';
        });
    }
}

async function retryFailedFigures(failedFigures) {
    console.log(`[图形] 重试 ${failedFigures.length} 个失败的图形`);

    for (const fig of failedFigures) {
        const desc = typeof fig.figure === 'string'
            ? fig.figure
            : (fig.figure.description || fig.figure.code || '');

        try {
            const resp = await fetch(`${API_BASE}/render/figure`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    description: desc,
                    stem: fig.stem || '',
                    subject: fig.subject
                })
            });

            const data = await resp.json();
            const el = document.getElementById(fig.id);
            if (!el) continue;

            if (data.svg) {
                el.innerHTML = data.svg;
                el.style.border = 'none';
                el.style.background = 'transparent';
                if (fig.qIdx !== undefined) {
                    state.figureCache.set(fig.qIdx, data.svg);
                }
            } else {
                // 重试也失败了，隐藏图形区域
                el.style.display = 'none';
            }
        } catch (e) {
            // 重试失败，隐藏图形区域
            const el = document.getElementById(fig.id);
            if (el) el.style.display = 'none';
        }
    }
}

function toggleQuestion(idx) {
    if (state.selectedQuestions.has(idx)) state.selectedQuestions.delete(idx);
    else state.selectedQuestions.add(idx);

    const card = document.querySelector(`.question-card[data-idx="${idx}"]`);
    if (card) card.classList.toggle('selected');
    updateSelectedCount();
}

function updateSelectedCount() {
    const count = state.selectedQuestions.size;
    document.getElementById('selectedCount').textContent = count;
    document.getElementById('composeBtn').disabled = count === 0;
}

function composeExam() {
    if (state.selectedQuestions.size === 0) { alert('请至少选择一道题目'); return; }

    console.log('[组卷] 开始组卷，已选题目数:', state.selectedQuestions.size);

    // 按原始索引排序，保持选题时的顺序
    const selectedIndices = Array.from(state.selectedQuestions).sort((a, b) => a - b);

    const groups = {};
    selectedIndices.forEach(idx => {
        const q = state.generatedQuestions[idx];
        if (!q) return;
        const type = q.groupType || 'other';
        if (!groups[type]) groups[type] = { title: q.groupTitle, items: [], order: getTypeOrder(type) };
        groups[type].items.push({ ...q, originalIdx: idx });
    });

    console.log('[组卷] 分组结果:', groups);

    // 按题型顺序排序（选择题、填空题、解答题）
    const sortedGroups = Object.entries(groups).sort((a, b) => a[1].order - b[1].order);

    // 重新编号
    let num = 1;
    sortedGroups.forEach(([type, group]) => {
        group.items.forEach(item => { item.index = num++; });
    });

    const groupsObj = Object.fromEntries(sortedGroups);
    console.log('[组卷] 最终数据:', groupsObj);

    renderExamPreview(state.currentExamData?.title || '试卷', groupsObj);
    switchToPreviewMode();
}

function getTypeOrder(type) {
    const order = { 'choice': 1, 'fill': 2, 'blank': 2, 'calculation': 3, 'qa': 3 };
    return order[type] || 99;
}

function renderExamPreview(title, groups) {
    console.log('[预览] 开始渲染试卷预览');

    // 重新显示标题编辑提示
    const titleHint = document.getElementById('titleEditHint');
    if (titleHint) { titleHint.style.display = ''; titleHint.style.opacity = '1'; }

    document.getElementById('paperTitle').textContent = title;
    let html = '';

    for (const [type, group] of Object.entries(groups)) {
        if (!group || !group.items || group.items.length === 0) {
            console.warn('[预览] 跳过空分组:', type);
            continue;
        }

        console.log(`[预览] 渲染分组 ${type}:`, group.title, '题目数:', group.items.length);
        html += `<div class="question-group"><div class="group-title">${group.title || ''}</div>`;

        for (const item of group.items) {
            if (!item) {
                console.warn('[预览] 跳过空题目');
                continue;
            }

            html += `<div class="question-item"><div class="q-stem">${item.index}. ${item.stem || ''}</div>`;

            if (type === 'choice' && item.options) {
                html += `<div class="q-options">${item.options.filter(o => o).map(o => `<div class="q-option">${o}</div>`).join('')}</div>`;
            }

            if (item.figure) {
                const cachedSvg = state.figureCache.get(item.originalIdx);
                if (cachedSvg) {
                    html += `<div class="q-figure" style="text-align:center">${cachedSvg}</div>`;
                } else {
                    console.warn(`[预览] 题${item.index}的图形未找到缓存，originalIdx:`, item.originalIdx);
                }
            }

            html += `</div>`;
        }
        html += `</div>`;
    }

    console.log('[预览] 生成的HTML长度:', html.length);

    const examContent = document.getElementById('examContent');
    if (!examContent) {
        console.error('[预览] 找不到examContent元素！');
        return;
    }

    examContent.innerHTML = html;
    console.log('[预览] HTML已插入到examContent');

    // 渲染答案
    if (state.currentExamData?.answers) {
        const indices = [...state.selectedQuestions].sort((a, b) => a - b);
        const answers = indices.map((idx, i) => {
            const orig = state.currentExamData.answers[idx];
            return orig ? `${i + 1}. ${orig.replace(/^\d+\.\s*/, '')}` : '';
        }).filter(a => a);
        document.getElementById('answerContent').innerHTML = answers.map(a => `<div>${a}</div>`).join('<br>');
        console.log('[预览] 答案已渲染，数量:', answers.length);
    }

    // 控制答案区域显示
    const showAnswerCheckbox = document.getElementById('showAnswer');
    const answerArea = document.getElementById('answerArea');
    if (showAnswerCheckbox && answerArea) {
        answerArea.style.display = showAnswerCheckbox.checked ? 'block' : 'none';
    }

    console.log('[预览] 试卷预览渲染完成');
}

function switchToSelectMode() {
    state.mode = 'select';
    document.getElementById('selectMode').style.display = 'block';
    document.getElementById('paper').classList.remove('show');
    document.getElementById('downloadBar').classList.remove('show');
}

function switchToPreviewMode() {
    state.mode = 'preview';
    document.getElementById('selectMode').style.display = 'none';
    document.getElementById('composeBar').style.display = 'none';
    const paper = document.getElementById('paper');
    paper.classList.add('show');
    document.getElementById('downloadBar').classList.add('show');
    console.log('[模式] 切换到预览模式, paper.display:', getComputedStyle(paper).display, 'paper.classList:', paper.classList.toString());
}

function backToSelect() {
    switchToSelectMode();
    document.getElementById('composeBar').style.display = 'flex';
}

async function exportToPdf() {
    const paper = document.getElementById('paper');
    const loadingEl = document.getElementById('loading');
    loadingEl.style.display = 'flex';

    try {
        if (!window.html2pdf) {
            await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js');
        }

        const titleText = document.getElementById('paperTitle').textContent;

        // 保存原始样式，只覆盖必要属性
        const origStyle = paper.style.cssText;
        paper.style.width = '210mm';
        paper.style.minHeight = '297mm';
        paper.style.maxWidth = '210mm';
        paper.style.padding = '20mm 26mm 25mm 4mm';
        paper.style.margin = '0 auto';
        paper.style.boxShadow = 'none';
        paper.style.display = 'block';

        // 隐藏密封线和标题提示
        const sealLine = paper.querySelector('.seal-line');
        if (sealLine) sealLine.style.display = 'none';
        const hint = paper.querySelector('.title-edit-hint');
        if (hint) hint.style.display = 'none';

        // SVG转canvas（html2canvas对SVG支持差）
        const svgBackups = [];
        for (const svg of paper.querySelectorAll('svg')) {
            try {
                const vb = svg.getAttribute('viewBox');
                let w = 400, h = 300;
                if (vb) { const p = vb.split(/[\s,]+/); w = parseFloat(p[2]) || 400; h = parseFloat(p[3]) || 300; }
                const svgClone = svg.cloneNode(true);
                if (!svgClone.getAttribute('xmlns')) svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
                svgClone.setAttribute('width', w); svgClone.setAttribute('height', h);
                const svgStr = new XMLSerializer().serializeToString(svgClone);
                const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const cvs = document.createElement('canvas');
                cvs.width = w * 2; cvs.height = h * 2;
                const ctx = cvs.getContext('2d');
                ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cvs.width, cvs.height); ctx.scale(2, 2);
                const img = new Image();
                await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = url; });
                ctx.drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url);
                cvs.style.cssText = 'max-width:250px;height:auto;display:block;margin:8px auto';
                svgBackups.push({ svg, parent: svg.parentNode });
                svg.parentNode.replaceChild(cvs, svg);
            } catch (e) {}
        }

        await html2pdf().set({
            margin: [10, 10, 10, 10],
            filename: `${titleText}.pdf`,
            image: { type: 'jpeg', quality: 0.95 },
            html2canvas: { scale: 2, useCORS: true, backgroundColor: '#fff' },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
            pagebreak: { mode: ['css', 'legacy'], avoid: '.question-item' }
        }).from(paper).save();

        // 恢复：SVG、密封线、提示、样式
        const allCanvas = paper.querySelectorAll('canvas');
        svgBackups.forEach(({ svg }, i) => { try { allCanvas[i].parentNode.replaceChild(svg, allCanvas[i]); } catch(e){} });
        if (sealLine) sealLine.style.display = '';
        if (hint) hint.style.display = '';
        paper.style.cssText = origStyle;

    } catch (e) {
        console.error('PDF导出失败:', e);
        alert('PDF导出失败，请尝试Ctrl+P打印');
    }
    loadingEl.style.display = 'none';
}

async function exportToWord() {
    const titleText = document.getElementById('paperTitle').textContent;
    const showAnswer = document.getElementById('showAnswer').checked;
    const loadingEl = document.getElementById('loading');
    loadingEl.style.display = 'flex';

    try {
        // 先将页面上的SVG转为base64图片映射
        const svgImgMap = new Map();
        const svgs = document.querySelectorAll('#examContent svg, #answerContent svg');
        for (const svg of svgs) {
            try {
                const vb = svg.getAttribute('viewBox');
                let w = 400, h = 300;
                if (vb) { const p = vb.split(/[\s,]+/); w = parseFloat(p[2]) || 400; h = parseFloat(p[3]) || 300; }

                const svgClone = svg.cloneNode(true);
                if (!svgClone.getAttribute('xmlns')) svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
                svgClone.setAttribute('width', w);
                svgClone.setAttribute('height', h);

                const svgStr = new XMLSerializer().serializeToString(svgClone);
                const svgB64 = btoa(unescape(encodeURIComponent(svgStr)));

                const canvas = document.createElement('canvas');
                canvas.width = w * 2; canvas.height = h * 2;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.scale(2, 2);

                const img = new Image();
                await new Promise((resolve, reject) => {
                    img.onload = resolve; img.onerror = reject;
                    img.src = 'data:image/svg+xml;base64,' + svgB64;
                });
                ctx.drawImage(img, 0, 0, w, h);

                const figDiv = svg.closest('.q-figure');
                if (figDiv) svgImgMap.set(figDiv, canvas.toDataURL('image/png'));
            } catch (e) { console.warn('SVG转换失败:', e); }
        }

        // 从state中构建干净的Word HTML（不从DOM抓取，避免重复节点）
        let questionsHtml = '';
        const examContent = document.getElementById('examContent');
        // 遍历examContent的子元素，构建干净HTML
        for (const child of examContent.children) {
            let childHtml = child.outerHTML;
            // 替换SVG为img
            const figDivs = child.querySelectorAll('.q-figure');
            for (const figDiv of figDivs) {
                const base64 = svgImgMap.get(figDiv);
                if (base64) {
                    const imgTag = `<p style="text-align:center;margin:10px 0"><img src="${base64}" width="200" height="auto" style="max-width:200px"></p>`;
                    childHtml = childHtml.replace(figDiv.outerHTML, imgTag);
                } else {
                    childHtml = childHtml.replace(figDiv.outerHTML, '');
                }
            }
            questionsHtml += childHtml;
        }

        let answerHtml = '';
        if (showAnswer) {
            answerHtml = document.getElementById('answerContent').innerHTML;
        }

        const wordHtml = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><meta charset='utf-8'><title>${titleText}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
@page { size: A4; margin: 2.5cm 2cm 3cm 2cm; }
body { font-family: '宋体', SimSun, serif; font-size: 12pt; line-height: 1.8; color: #000; }
.exam-header { text-align: center; border-bottom: 2pt solid #000; padding-bottom: 8pt; margin-bottom: 16pt; }
.exam-title { font-size: 18pt; font-weight: bold; margin-bottom: 12pt; }
.secret-mark { text-align: left; font-size: 9pt; font-weight: bold; margin-bottom: 8pt; }
.exam-info { text-align: center; font-size: 12pt; margin-top: 12pt; }
.question-group { margin-bottom: 16pt; }
.group-title { font-weight: bold; font-size: 14pt; margin-bottom: 8pt; }
.question-item { margin-bottom: 12pt; font-size: 12pt; line-height: 1.8; }
.q-stem { font-weight: normal; margin-bottom: 4pt; }
.q-options { margin-left: 2em; }
.q-option { display: inline-block; min-width: 22%; margin-right: 0.25em; }
.answer-key { margin-top: 30pt; border-top: 1pt dashed #999; padding-top: 16pt; }
.answer-key .group-title { font-weight: bold; font-size: 14pt; margin-bottom: 8pt; }
</style></head>
<body>
<div class="exam-header">
<div class="secret-mark">绝密 ★ 启用前</div>
<div class="exam-title">${titleText}</div>
<div class="exam-info">姓名：____________ 班级：____________ 考号：____________</div>
</div>
${questionsHtml}
${showAnswer ? `<div class="answer-key"><div class="group-title">参考答案与解析</div>${answerHtml}</div>` : ''}
</body></html>`;

        const blob = new Blob(['\ufeff' + wordHtml], { type: 'application/msword;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = `${titleText}.doc`;
        document.body.appendChild(link); link.click();
        document.body.removeChild(link); URL.revokeObjectURL(url);
    } catch (e) {
        console.error('Word导出失败:', e);
        alert('Word导出失败: ' + e.message);
    }
    loadingEl.style.display = 'none';
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
    });
}

function showContactModal() {
    const globalBtn = document.getElementById('cyberGlobalContactBtn');
    if (globalBtn) { globalBtn.click(); return; }
    document.getElementById('contactModal').classList.add('show');
}

function closeModal(id) { document.getElementById(id).classList.remove('show'); }

const SETTINGS_KEY = 'exam_settings_v3';

function saveSettings() {
    const s = {
        version: document.getElementById('version').value,
        subject: document.getElementById('subject').value,
        grade: document.getElementById('grade').value,
        difficulty: document.getElementById('difficulty').value,
        examType: document.getElementById('examType').value,
        showAnswer: document.getElementById('showAnswer').checked,
        questionCount: document.getElementById('questionCountInput').value
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function loadSettings() {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (!saved) return;
    try {
        const s = JSON.parse(saved);
        if (s.version) document.getElementById('version').value = s.version;
        if (s.subject) document.getElementById('subject').value = s.subject;
        if (s.grade) document.getElementById('grade').value = s.grade;
        if (s.difficulty) {
            document.getElementById('difficulty').value = s.difficulty;
            document.getElementById('difficultyValue').textContent = s.difficulty;
        }
        if (s.examType) document.getElementById('examType').value = s.examType;
        if (s.showAnswer !== undefined) document.getElementById('showAnswer').checked = s.showAnswer;
        if (s.questionCount) {
            document.getElementById('questionCount').value = s.questionCount;
            document.getElementById('questionCountInput').value = s.questionCount;
        }
    } catch (e) { console.error('加载设置失败', e); }
}

document.getElementById('showAnswer').addEventListener('change', (e) => {
    document.getElementById('answerArea').style.display = e.target.checked ? 'block' : 'none';
    saveSettings();
});

['examType'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', saveSettings);
});
