import './style.css';
import './security-client.js';
import './main.js';

const bindEvent = (id, eventName, handler) => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener(eventName, handler);
  }
};

bindEvent('wrongQuestionFile', 'change', (e) => window.handleWrongQuestionUpload(e.target));
bindEvent('generateBtn', 'click', () => window.generateExam());
bindEvent('composeBtn', 'click', () => window.composeExam());
bindEvent('showAnswer', 'change', (e) => {
  const answerArea = document.getElementById('answerArea');
  if (answerArea) answerArea.style.display = e.target.checked ? 'block' : 'none';
  if (typeof window.saveSettings === 'function') {
    window.saveSettings();
  }
});
bindEvent('showOriginal', 'change', () => {
  if (typeof window.handleShowOriginalChange === 'function') {
    window.handleShowOriginalChange();
    return;
  }
  if (typeof window.saveSettings === 'function') {
    window.saveSettings();
  }
});
bindEvent('count_similar', 'change', () => window.saveSettings?.());
bindEvent('count_variant', 'change', () => window.saveSettings?.());
bindEvent('count_application', 'change', () => window.saveSettings?.());

const backBtn = document.querySelector('.preview-bottom-bar .bar-btn');
if (backBtn) {
  backBtn.addEventListener('click', () => window.backToSelect());
}

const exportButtons = document.querySelectorAll('.preview-bottom-bar .bar-btn.primary');
if (exportButtons[0]) {
  exportButtons[0].addEventListener('click', () => window.exportToPdf());
}
if (exportButtons[1]) {
  exportButtons[1].addEventListener('click', () => window.exportToWord());
}

const modalCloseBtn = document.querySelector('#contactModal .modal-close');
if (modalCloseBtn) {
  modalCloseBtn.addEventListener('click', () => window.closeModal('contactModal'));
}
