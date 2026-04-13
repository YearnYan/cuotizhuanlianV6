/**
 * 结构化题目校验器 — 硬规则校验（不依赖AI）
 * 第四层防线：对生成的试卷进行代码级结构化校验与自动修复
 */

function extractCircuitLabelTokens(text) {
  const normalized = String(text || '').toUpperCase();
  const matches = normalized.match(/\b(?:S\d+|R\d+|L\d+|S|R|L)\b/g) || [];
  const unique = Array.from(new Set(matches));
  const hasSpecific = unique.some((token) => /\d/.test(token));
  return hasSpecific
    ? unique.filter((token) => /\d/.test(token))
    : unique.filter((token) => token === 'S' || token === 'R' || token === 'L');
}

function isCircuitLikeText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  if (/(电路|开关|电阻|灯泡|串联|并联|欧姆|Ω|电压|电流|伏特|安培)/.test(raw)) return true;
  return extractCircuitLabelTokens(raw).length > 0;
}

function getFigureDescription(figure) {
  if (!figure) return '';
  if (typeof figure === 'string') return figure;
  if (typeof figure === 'object') return String(figure.description || '').trim();
  return '';
}

function checkCircuitFigureConsistency(stem, figureDescription) {
  const stemTokens = extractCircuitLabelTokens(stem);
  const figureTokens = extractCircuitLabelTokens(figureDescription);
  const missingTokens = stemTokens.filter((token) => !figureTokens.includes(token));
  const extraTokens = figureTokens.filter((token) => !stemTokens.includes(token));
  return {
    isCircuitLike: isCircuitLikeText(stem) || isCircuitLikeText(figureDescription),
    stemTokens,
    figureTokens,
    missingTokens,
    extraTokens
  };
}

/**
 * 校验整份试卷的结构化正确性
 * @param {object} exam - 试卷对象
 * @returns {{ valid: boolean, errors: string[], warnings: string[], fixedItems: string[] }}
 */
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

      // ── 1. answer 不能为空 ──
      if (!item.answer || !String(item.answer).trim()) {
        errors.push(`题${idx}: answer 为空`);
      }

      // ── 2. explanation 不能为空 ──
      if (!item.explanation || !String(item.explanation).trim()) {
        errors.push(`题${idx}: explanation 为空`);
      }

      // ── 3. stem 不能过短 ──
      if (!item.stem || String(item.stem).trim().length < 8) {
        errors.push(`题${idx}: 题干过短或为空，可能不完整`);
      }

      // ── 4. 选择题特殊校验 ──
      if (item.options && Array.isArray(item.options) && item.options.length > 0) {
        // 4a. 选项数量
        if (item.options.length < 2) {
          errors.push(`题${idx}: 选项数量不足（仅${item.options.length}个）`);
        }

        // 4b. answer 应为有效选项字母
        const answerStr = String(item.answer || '').trim();
        const validLetters = item.options.map((_, i) => String.fromCharCode(65 + i));
        const firstChar = answerStr.charAt(0).toUpperCase();

        if (answerStr.length === 1 && validLetters.includes(answerStr.toUpperCase())) {
          // answer 是单个字母 — 规范化为大写
          if (item.answer !== firstChar) {
            item.answer = firstChar;
            fixedItems.push(`题${idx}: answer 规范化为 "${firstChar}"`);
          }
        } else if (answerStr.length > 1) {
          // 尝试从 "A. xxx" 或 "A选项内容" 等格式中提取字母
          const letterMatch = answerStr.match(/^([A-Da-d])/);
          if (letterMatch) {
            const letter = letterMatch[1].toUpperCase();
            if (validLetters.includes(letter)) {
              item.answer = letter;
              fixedItems.push(`题${idx}: answer 从 "${answerStr}" 提取并规范化为 "${letter}"`);
            } else {
              warnings.push(`题${idx}: answer "${answerStr}" 首字母 ${letter} 不在选项范围 ${validLetters.join('/')} 内`);
            }
          } else {
            warnings.push(`题${idx}: answer "${answerStr}" 不是标准选项字母格式`);
          }
        } else if (!validLetters.includes(firstChar)) {
          errors.push(`题${idx}: answer "${answerStr}" 不在选项范围 ${validLetters.join('/')} 内`);
        }

        // 4c. 各选项不能为空
        for (let i = 0; i < item.options.length; i++) {
          const opt = String(item.options[i] || '').trim();
          if (!opt) {
            errors.push(`题${idx}: 选项${String.fromCharCode(65 + i)}为空`);
          }
        }

        // 4d. 检查选项是否有重复内容
        const optionTexts = item.options.map(o => String(o || '').replace(/^[A-D][.、．]\s*/, '').trim());
        const uniqueTexts = new Set(optionTexts);
        if (uniqueTexts.size < optionTexts.length) {
          warnings.push(`题${idx}: 存在重复选项`);
        }
      }

      // ── 5. 乱码检测 ──
      const stemStr = String(item.stem || '');
      // 连续4个以上非常规字符（排除中文、英文、数字、常用标点、数学符号等）
      if (/[^\u4e00-\u9fa5a-zA-Z0-9\s.,;:!?()（）【】\[\]、。，；：！？""''…—\-+×÷=≈≠≤≥≪≫<>°%‰√πα-ωΑ-Ω²³⁴⁵⁶⁷⁸⁹⁰⁺⁻⁼⁽⁾ⁿⁱ₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₙᵢ∠△∥⊥≅∽□∈∉⊂⊃⊆⊇∪∩∅∀∃¬∧∨→←⇒⇐⇔∞∂∇∴∵·±∓∝≡∓⁰¹/\\_{}|~@#$&*^`'"\n\r\t]{4,}/.test(stemStr)) {
        warnings.push(`题${idx}: 题干可能包含乱码或异常字符`);
      }

      // ── 6. explanation 与 answer 关联性检查 ──
      if (item.explanation && item.answer) {
        const explanation = String(item.explanation);
        const answer = String(item.answer).trim();

        if (item.options && Array.isArray(item.options) && item.options.length > 0) {
          // 选择题：解析中应提及正确选项
          const letter = answer.charAt(0).toUpperCase();
          if (letter >= 'A' && letter <= 'D') {
            // 检查解析中是否包含选项字母或选项内容
            const optIdx = letter.charCodeAt(0) - 65;
            const optContent = item.options[optIdx]
              ? String(item.options[optIdx]).replace(/^[A-D][.、．]\s*/, '').trim()
              : '';
            if (!explanation.includes(letter) && (!optContent || !explanation.includes(optContent.substring(0, 10)))) {
              warnings.push(`题${idx}: 解析中未提及正确选项 ${letter} 或其内容`);
            }
          }
        }
      }

      // ── 7. 残留图形引用检查 ──
      const figRefPattern = /如图|见图|下图|图中|由图/;
      if (figRefPattern.test(stemStr) && !item.figure) {
        warnings.push(`题${idx}: 题干提到图形引用但缺少 figure 字段`);
      }

      // ── 7b. 电路题图文一致性检查 ──
      if (item.figure) {
        const figureDescription = getFigureDescription(item.figure);
        const consistency = checkCircuitFigureConsistency(stemStr, figureDescription);
        if (consistency.isCircuitLike && consistency.missingTokens.length > 0) {
          errors.push(`题${idx}: 图文一致性失败，题干标签 ${consistency.missingTokens.join('/')} 未在 figure 中体现`);
        }
        if (consistency.isCircuitLike && consistency.extraTokens.length > 0) {
          warnings.push(`题${idx}: figure 可能包含题干未出现的标签 ${consistency.extraTokens.join('/')}`);
        }
      }

      // ── 8. explanation 长度检查 ──
      if (item.explanation && String(item.explanation).trim().length < 15) {
        warnings.push(`题${idx}: explanation 过短（${String(item.explanation).trim().length}字），可能缺少推导过程`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    fixedItems
  };
}

module.exports = { validateExam };
