// AISecretary Dashboard - Commit 1 骨架版
// 完整的授权 + 读取 + 渲染逻辑在后续 commit 实现

const grantBtn = document.getElementById('grant-btn');
const status = document.getElementById('status');

grantBtn.addEventListener('click', () => {
  status.textContent = '授权功能将在 Commit 2 实装';
  status.style.color = 'var(--accent)';
});
