const log = (...a) => console.log('[GitCheck][bg]', ...a);
const warn = (...a) => console.warn('[GitCheck][bg]', ...a);
const err = (...a) => console.error('[GitCheck][bg]', ...a);

self.addEventListener('unhandledrejection', e => {
  console.error('[GitCheck][bg] unhandledrejection', e.reason);
});
self.addEventListener('error', e => {
  console.error('[GitCheck][bg] error', e.message, e.error);
});

// ===== 설정 로드 =====
function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      {
        gitlabToken: '',
        gitlabDomain: 'lab.ssafy.com',
        repos: [],
        memberMap: {},   // { "이름": {emails:[], names:["이름"]} } (선택)
        appsScriptUrl: '',
        sheet: { spreadsheetId: '', sheetName: '주간 Git 현황', headerRow: 6, nameCol: 3 },
        days: 14,
        timezoneOffsetMinutes: 9 * 60
      },
      async (cfg) => {
        const loc = await chrome.storage.local.get({ gitlabToken: '' });
        if (loc.gitlabToken) cfg.gitlabToken = loc.gitlabToken;

        // 로그
        log('getConfig loaded', {
          domain: cfg.gitlabDomain,
          repos: cfg.repos,
          sheet: cfg.sheet,
          days: cfg.days,
          appsScriptUrl: cfg.appsScriptUrl ? '(set)' : '(missing)',
          tokenSet: !!cfg.gitlabToken
        });

        resolve(cfg);
      }
    );
  });
}


// ===== GitLab API =====
async function getProjectId(repoPath, cfg) {
  const encodedPath = encodeURIComponent(String(repoPath).replace(/^\//, ''));
  const url = `https://${cfg.gitlabDomain}/api/v4/projects/${encodedPath}`;
  log('getProjectId:', repoPath, '→', url);

  const res = await fetch(url, {
    headers: { 'PRIVATE-TOKEN': cfg.gitlabToken, 'Accept': 'application/json' }
  });

  if (!res.ok) throw new Error(`getProjectId failed ${res.status}`);
  const data = await res.json();

  // 로그
  log('getProjectId ok', { repoPath, projectId: data.id, name: data.name_with_namespace });

  return data.id;
}

async function getBranches(projectId, cfg) {
  try {
    const res = await fetch(
      `https://${cfg.gitlabDomain}/api/v4/projects/${projectId}/repository/branches`,
      { headers: { 'PRIVATE-TOKEN': cfg.gitlabToken, 'Accept': 'application/json' } }
    );
    if (!res.ok) {
      warn('getBranches failed, fallback main/master/develop', res.status);
      return ['main', 'master', 'develop'];
    }
    const arr = await res.json();
    log('getBranches ok', { projectId, count: arr.length, names: arr.map(b => b.name).slice(0, 10) });
    return arr.map(b => b.name);
  } catch (e) {
    err('getBranches exception, fallback', e);
    return ['main', 'master', 'develop'];
  }
}

async function collectCommits(projectId, cfg) {
  const since = new Date(); since.setDate(since.getDate() - cfg.days);
  const sinceDate = since.toISOString().split('T')[0];

  // 로그
  log('collectCommits since', { projectId, sinceDate });

  const branches = await getBranches(projectId, cfg);
  const perPage = 100;
  const all = [];

  for (const branch of branches) {
    let page = 1;
    while (true) {
      const url =
        `https://${cfg.gitlabDomain}/api/v4/projects/${projectId}/repository/commits?` +
        `since=${sinceDate}T00:00:00Z&ref_name=${encodeURIComponent(branch)}&per_page=${perPage}&page=${page}`;
      const res = await fetch(url, { headers: { 'PRIVATE-TOKEN': cfg.gitlabToken, 'Accept': 'application/json' } });
      if (!res.ok) {
        warn('commits fetch failed', { projectId, branch, status: res.status, page });
        break;
      }
      const commits = await res.json();

      // 로그
      log('commits page', { branch, page, count: commits.length });

      if (!commits.length) break;

      commits
        .filter(c => !c.title.startsWith('Merge branch'))
        .forEach(c => all.push({
          id: c.id,
          title: c.title,
          author_name: c.author_name,
          author_email: c.author_email,
          created_at: c.created_at
        }));

      if (commits.length < perPage) break;
      page++;
    }
  }

  // 커밋 ID 기준 중복 제거
  const map = new Map();
  all.forEach(c => map.set(c.id, c));
  const deduped = Array.from(map.values());
  log('collectCommits done', { projectId, total: all.length, deduped: deduped.length });
  return deduped;
}

// ===== 집계 =====
function aggregateByDateAndMember(commits, cfg, memberMap) {
  const counts = {}; // counts[name][yyyy-mm-dd] = n
  const hasMap = memberMap && Object.keys(memberMap).length > 0;

  log('aggregate start', { commits: commits.length, hasMap });

  for (const c of commits) {
    const dt = new Date(c.created_at);
    dt.setMinutes(dt.getMinutes() + cfg.timezoneOffsetMinutes);
    const day = dt.toISOString().split('T')[0];

    const email = (c.author_email || '').toLowerCase();
    const author = (c.author_name || '').trim() || '(unknown)';

    if (!hasMap) {
      // 매핑이 없으면 author_name 그대로 사용
      (counts[author] ??= {}), (counts[author][day] = (counts[author][day] || 0) + 1);
      continue;
    }

    // 매핑이 있으면 매핑 우선
    let matched = false;
    for (const name of Object.keys(memberMap)) {
      const m = memberMap[name] || {};
      const emailMatch = (m.emails || []).some(e => e.toLowerCase() === email);
      const nameMatch = (m.names || []).some(n => n === author);
      if (emailMatch || nameMatch || name === author) {
        (counts[name] ??= {}), (counts[name][day] = (counts[name][day] || 0) + 1);
        matched = true;
        break;
      }
    }
    if (!matched) {
      // 미매칭도 별도 키로 남겨서 나중에 시트에서 확인 가능
      const key = `미매칭:${author} <${email}>`;
      (counts[key] ??= {}), (counts[key][day] = (counts[key][day] || 0) + 1);
    }
  }
  // 요약 로그
  const names = Object.keys(counts);
  log('aggregate done', {
    memberCount: names.length,
    sample: names.slice(0, 5).map(n => ({ name: n, days: Object.keys(counts[n]).length }))
  });
  return counts;
}

// ===== 메시지 수신 =====
// ===== 메시지 수신 =====
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'RUN_COLLECT_AND_WRITE') return;

  (async () => {
    try {
      const cfg = await getConfig();
      if (!cfg.appsScriptUrl) throw new Error('Apps Script URL이 비어있습니다. 팝업에서 설정하세요.');
      if (!cfg.sheet?.spreadsheetId) throw new Error('시트 ID가 비어있습니다. 팝업에서 설정하세요.');
      if (!cfg.gitlabToken) throw new Error('GitLab Token이 비어있습니다. 팝업에서 설정하세요.');

      const repos = Array.isArray(cfg.repos) ? cfg.repos
        : String(cfg.repos || '').split(',').map(s => s.trim()).filter(Boolean);

      log('target repos', repos);

      const allCommits = [];
      for (const repo of repos) {
        try {
          const pid = await getProjectId(repo, cfg);
          const commits = await collectCommits(pid, cfg);
          log('repo done', { repo, pid, commits: commits.length });

          // [NEW] 각 커밋에 repo 라벨을 달아둔다 (팝업에 표시할 때 사용)
          commits.forEach(c => allCommits.push({ ...c, repo }));  // ← 기존 push(...commits) 대신

        } catch (e) {
          err('repo failed', repo, e);
        }
      }

      log('all repos collected', { totalCommits: allCommits.length });

      const counts = aggregateByDateAndMember(allCommits, cfg, cfg.memberMap || {});

      // [NEW] 사람별 원본 커밋(커밋ID 기준 '사람 내부에서만' 중복 제거) 요약 만들기
      // team은 있으면 memberMap에서 끌어오고, 없으면 빈 문자열
      const perPerson = {}; // { name: { team:'', ids:Set, list:[{id,title,date,repo}] } }
      for (const c of allCommits) {
        const name = (c.author_name || '(unknown)').trim();
        const info = (cfg.memberMap && cfg.memberMap[name]) || {};
        if (!perPerson[name]) perPerson[name] = { team: info.team || '', ids: new Set(), list: [] };

        if (!perPerson[name].ids.has(c.id)) {           // 사람 내부에서만 중복 제거
          perPerson[name].ids.add(c.id);
          perPerson[name].list.push({
            id: c.id,
            title: c.title,
            date: (c.created_at || '').slice(0, 10),
            repo: c.repo || ''
          });
        }
      }

      // [NEW] summary(팀,이름,개수) + 상세(list 일부 미리보기) 생성
      const summary = Object.entries(perPerson).map(([name, v]) => ({
        team: v.team || '',
        name,
        count: v.ids.size
      })).sort((a, b) =>
          (a.team||'').localeCompare(b.team||'') || a.name.localeCompare(b.name)
      );

      // [NEW] 메시지 페이로드가 너무 커지는 것 방지: 미리보기는 최대 20개만
      const previewDetail = {};
      for (const [name, v] of Object.entries(perPerson)) {
        previewDetail[name] = v.list.slice(0, 20);
      }

      // === Apps Script 쓰기 ===
      const payload = {
        spreadsheetId: cfg.sheet.spreadsheetId,
        sheetName: cfg.sheet.sheetName,
        headerRow: cfg.sheet.headerRow,
        nameCol: cfg.sheet.nameCol,
        counts
      };

      const res = await fetch(cfg.appsScriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const text = await res.text().catch(() => '');
      log('Apps Script response', res.status, text?.slice(0, 500));
      if (!res.ok) throw new Error(`Apps Script write failed ${res.status}`);

      // [NEW] 시트 쓰기 성공 후, 요약/미리보기까지 함께 반환
      sendResponse({
        ok: true,
        summary,          // [{team,name,count}, ...]
        previewDetail     // { "홍길동": [{id,title,date,repo}, ... up to 20], ... }
      });

    } catch (e) {
      console.error(e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true; // ★ 포트 유지 (중요)
});

