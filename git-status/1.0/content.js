(function () {
  const titleEl = document.querySelector('title');
  const title = titleEl ? titleEl.textContent : '';
  if (!title || !title.includes('주간 Git 현황')) return;

  // 중복 방지
  if (document.getElementById('wgcc-float-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'wgcc-float-btn';
  btn.textContent = '커밋 집계/기록';
  Object.assign(btn.style, {
    position: 'fixed',
    right: '24px',
    bottom: '24px',
    zIndex: 999999,
    padding: '10px 14px',
    borderRadius: '999px',
    border: 'none',
    boxShadow: '0 6px 18px rgba(0,0,0,.2)',
    background: '#1da1f2',
    color: '#fff',
    fontWeight: '600',
    cursor: 'pointer'
  });
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = '집계 중...';
    const tab = { url: location.href, title: document.title };

    chrome.runtime.sendMessage({ type: 'RUN_COLLECT_AND_WRITE', tab }, (res) => {
      btn.disabled = false;
      btn.textContent = res?.ok ? '완료!' : '실패(콘솔확인)';
      setTimeout(() => (btn.textContent = '커밋 집계/기록'), 2000);
    });
  };
  document.body.appendChild(btn);
})();
