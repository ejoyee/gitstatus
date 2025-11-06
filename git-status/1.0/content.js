// content.js
(function () {
  if (window.top !== window) return;

  const title = document.title || '';
  if (!title.includes('주간 Git 현황')) return;

  if (document.getElementById('wgcc-float-btn')) return;

  // [NEW] 마지막 결과를 메모리에도 들고 있고, storage에도 보관
  // └ 페이지 새로고침 후에도 [결과 보기]가 살아 있도록 함
  let lastSummary = null;       // [{team,name,count}, ...]
  let lastPreviewDetail = null; // { name: [{id,title,date,repo}, ...] }

  // [ADD] 안전한 메시지 전송 유틸 (컨텍스트 끊김 방지용, 1회 재시도 + 안내)
  async function sendMessageSafe(msg) {
    // 확장프로그램 컨텍스트 존재 확인
    if (!chrome || !chrome.runtime || !chrome.runtime.id) {
      console.warn('[GitCheck][content] runtime.id missing (extension likely reloaded)');
      throw new Error('Extension context not available. Please refresh the page.');
    }
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      const m = String(e && (e.message || e));
      if (m.includes('Extension context invalidated')) {
        console.warn('[GitCheck][content] context invalidated → retry once…');
        // 서비스워커 깨우는 짧은 대기 후 1회 재시도
        await new Promise(r => setTimeout(r, 250));
        try {
          return await chrome.runtime.sendMessage(msg);
        } catch (e2) {
          throw new Error('Extension reloaded. Please refresh the page and try again.');
        }
      }
      throw e;
    }
  }







  // ▼ 기존: 메인 실행 버튼
  const runBtn = document.createElement('button');
  runBtn.id = 'wgcc-float-btn';
  runBtn.textContent = '커밋 집계/기록';
  Object.assign(runBtn.style, {
    position: 'fixed', right: '24px', bottom: '24px', zIndex: 999999,
    padding: '10px 14px', borderRadius: '999px', border: 'none',
    boxShadow: '0 6px 18px rgba(0,0,0,.2)', background: '#1da1f2',
    color: '#fff', fontWeight: '600', cursor: 'pointer'
  });

  // [NEW] 결과 보기 버튼 (처음엔 숨김)
  const viewBtn = document.createElement('button');
  viewBtn.id = 'wgcc-view-btn';
  viewBtn.textContent = '결과 보기';
  Object.assign(viewBtn.style, {
    position: 'fixed', right: '24px', bottom: '74px', // ← runBtn 위에 50px 간격
    zIndex: 999999,
    padding: '10px 14px', borderRadius: '999px', border: '1px solid #d0d7de',
    boxShadow: '0 6px 18px rgba(0,0,0,.12)', background: '#fff',
    color: '#111', fontWeight: '600', cursor: 'pointer', display: 'none'
  });

  // ▼ 기존: 모달 생성 함수 (변경 없음)
  function showModal(summary, previewDetail) {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:999999;';
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);' +
      'width:min(1000px,90vw);max-height:80vh;overflow:auto;background:#fff;' +
      'border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:18px;';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
    head.innerHTML = `
      <div style="font-weight:700;font-size:16px">Git 커밋 요약 (사람 내부 중복제거)</div>
      <div style="display:flex;gap:8px;align-items:center">
        <button id="wgcc-download-csv" style="padding:6px 10px;border-radius:8px;border:1px solid #ddd;background:#f8f8f8;cursor:pointer">CSV 다운로드</button>
        <button id="wgcc-close" style="padding:6px 10px;border-radius:8px;border:1px solid #ddd;background:#fff;cursor:pointer">닫기</button>
      </div>
    `;

    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;';
    table.innerHTML = `
      <thead>
        <tr>
          <th style="text-align:left;border-bottom:1px solid #eee;padding:6px 4px;width:100px">팀</th>
          <th style="text-align:left;border-bottom:1px solid #eee;padding:6px 4px;width:180px">이름</th>
          <th style="text-align:right;border-bottom:1px solid #eee;padding:6px 4px;width:80px">개수</th>
          <th style="text-align:left;border-bottom:1px solid #eee;padding:6px 4px;">미리보기(최대 20개)</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');

    const rows = (summary || []).slice().sort((a, b) =>
      (a.team || '').localeCompare(b.team || '') || a.name.localeCompare(b.name)
    );
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="border-bottom:1px solid #f1f1f1;padding:6px 4px">${row.team || '-'}</td>
        <td style="border-bottom:1px solid #f1f1f1;padding:6px 4px">${row.name}</td>
        <td style="border-bottom:1px solid #f1f1f1;padding:6px 4px;text-align:right">${row.count}</td>
        <td style="border-bottom:1px solid #f1f1f1;padding:6px 4px">
          ${(previewDetail?.[row.name] || []).map(c =>
        `<code style="background:#f6f8fa;padding:2px 4px;border-radius:4px;display:inline-block;margin:2px 4px 2px 0">${c.date} · ${c.repo} · ${c.title}</code>`
      ).join('')}
        </td>
      `;
      tbody.appendChild(tr);
    }

    function toCsv() {
      const header = ['team', 'name', 'count'];
      const lines = [header.join(',')];
      for (const r of rows) {
        const cells = [r.team || '', r.name, String(r.count)]
          .map(s => `"${String(s).replaceAll('"', '""')}"`);
        lines.push(cells.join(','));
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `git-summary-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }

    wrap.appendChild(head);
    wrap.appendChild(table);
    overlay.appendChild(wrap);
    document.body.appendChild(overlay);

    overlay.querySelector('#wgcc-close').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.querySelector('#wgcc-download-csv').onclick = () => toCsv();
  }

  // [NEW] 결과 보기 버튼 핸들러 — 저장된 결과로 언제든 모달 재오픈
  viewBtn.onclick = () => {
    if (lastSummary && lastPreviewDetail) {
      showModal(lastSummary, lastPreviewDetail);
    } else {
      // 저장된 게 없으면 storage에서 한 번 더 시도(새로고침 직후 대비)
      chrome.storage.local.get(['wgcc_last_summary', 'wgcc_last_preview'], (st) => {
        lastSummary = st.wgcc_last_summary || null;
        lastPreviewDetail = st.wgcc_last_preview || null;
        if (lastSummary && lastPreviewDetail) {
          showModal(lastSummary, lastPreviewDetail);
        } else {
          alert('표시할 결과가 없습니다. 먼저 "커밋 집계/기록"을 실행해 주세요.');
        }
      });
    }
  };

  // [CHANGE] runBtn.onclick 내부의 sendMessage 호출 부분만 안전 함수로 교체
  runBtn.onclick = async () => {
    runBtn.disabled = true;
    runBtn.textContent = '집계 중...';
    try {
      console.log('[GitCheck][content] ▶ RUN_COLLECT_AND_WRITE start');

      // 변경: sendMessageSafe(...)
      const res = await sendMessageSafe({ type: 'RUN_COLLECT_AND_WRITE' });

      console.log('[GitCheck][content] ◀ response:', res);

      if (res?.ok && Array.isArray(res.summary)) {
        lastSummary = res.summary; 
        lastPreviewDetail = res.previewDetail || {};

        chrome.storage.local.set({
          wgcc_last_summary: lastSummary,
          wgcc_last_preview: lastPreviewDetail,
          wgcc_last_at: Date.now()
        });

        viewBtn.style.display = 'inline-block';
        showModal(lastSummary, lastPreviewDetail);
        runBtn.textContent = '완료!';
      } else {
        runBtn.textContent = '실패(옵션/콘솔 확인)';
      }
    } catch (err) {
      console.error('[GitCheck][content] sendMessage error:', err);
      // [ADD] 컨텍스트 문제면 사용자에게 새로고침 안내
      alert('확장 프로그램 연결이 끊겼습니다.\n페이지를 새로고침(F5)한 뒤 다시 시도해 주세요.');
      runBtn.textContent = '실패(연결 오류)';
    } finally {
      setTimeout(() => { runBtn.disabled = false; runBtn.textContent = '커밋 집계/기록'; }, 1500);
    }
  };

  // [NEW] 페이지 로딩 시, 직전 실행 결과가 storage에 있으면 [결과 보기] 버튼을 바로 노출
  chrome.storage.local.get(['wgcc_last_summary', 'wgcc_last_preview'], (st) => {
    if (st.wgcc_last_summary && st.wgcc_last_preview) {
      lastSummary = st.wgcc_last_summary;
      lastPreviewDetail = st.wgcc_last_preview;
      viewBtn.style.display = 'inline-block';
    }
  });

  document.body.appendChild(runBtn);
  document.body.appendChild(viewBtn); // [NEW] 두 번째 버튼 추가
})();
