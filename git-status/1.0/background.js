// 간단한 유틸
const dayjs = (d) => new Date(d);

// 옵션 저장값 읽기
function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      {
        gitlabToken: '',
        gitlabDomain: 'lab.ssafy.com',
        repos: [],                 // 예: ["/org/repo1", "/org/repo2"]
        memberMap: {},            // { "시트이름": { emails:["a@x.com","b@y.com"], names:["홍길동"] } }
        // appsScriptUrl: '',        // 배포한 웹앱 URL
        appsScriptUrl: 'https://script.google.com/macros/s/AKfycbyIq09lJjgUeX0NhznAFrKRwjntYiV0KoFQPfyHULwe4LjQNeGyvJn8lGyWiAwTFs1AHg/exec',
        sheet: {
          spreadsheetId: '',
          sheetName: '주간 Git 현황',
          headerRow: 6,           // 날짜 헤더가 있는 행(예시)
          nameCol: 2              // "이름" 열 번호(예시, 1-based: B열=2)
        },
        days: 14,                 // 최근 14일
        timezoneOffsetMinutes: 9 * 60 // KST 정규화
      },
      resolve
    );
  });
}

// GitLab projectId 조회 (filecite)
async function getProjectId(repoPath, cfg) {
  const encodedPath = encodeURIComponent(repoPath.substring(1));
  const res = await fetch(`https://${cfg.gitlabDomain}/api/v4/projects/${encodedPath}`, {
    headers: {
      'PRIVATE-TOKEN': cfg.gitlabToken,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`getProjectId failed ${res.status}`);
  const data = await res.json();
  return data.id;
}

// 브랜치 목록 조회 (fallback 가능) (filecite)
async function getBranches(projectId, cfg) {
  const res = await fetch(`https://${cfg.gitlabDomain}/api/v4/projects/${projectId}/repository/branches`, {
    headers: { 'PRIVATE-TOKEN': cfg.gitlabToken, 'Accept': 'application/json' }
  });
  if (!res.ok) return ['main','master','develop'];
  const arr = await res.json();
  return arr.map(b => b.name);
}

// 기간 커밋 수집 + 머지커밋 제거 + 중복 제거 (filecite)
async function collectCommits(projectId, cfg) {
  const since = new Date();
  since.setDate(since.getDate() - cfg.days);
  const sinceDate = since.toISOString().split('T')[0];

  const branches = await getBranches(projectId, cfg);
  const perPage = 100;
  const all = [];

  for (const branch of branches) {
    let page = 1;
    while (true) {
      const url = `https://${cfg.gitlabDomain}/api/v4/projects/${projectId}/repository/commits?` +
                  `since=${sinceDate}T00:00:00Z&ref_name=${encodeURIComponent(branch)}&per_page=${perPage}&page=${page}`;
      const res = await fetch(url, {
        headers: { 'PRIVATE-TOKEN': cfg.gitlabToken, 'Accept': 'application/json' }
      });
      if (!res.ok) break;
      const commits = await res.json();
      if (!commits.length) break;

      commits
        .filter(c => !c.title.startsWith('Merge branch'))                         // 머지 제거  :contentReference[oaicite:5]{index=5}
        .forEach(c => {
          all.push({
            id: c.id,
            title: c.title,
            author_name: c.author_name,
            author_email: c.author_email,
            created_at: c.created_at
          });
        });

      if (commits.length < perPage) break;
      page++;
    }
  }

  // 커밋 ID 기준 중복 제거  (web_url 기준 제거 구현과 동등)  :contentReference[oaicite:6]{index=6}
  const map = new Map();
  all.forEach(c => map.set(c.id, c));
  return Array.from(map.values());
}

// 일자별/사람별 카운트 집계
function aggregateByDateAndMember(commits, cfg, memberMap) {
  const counts = {}; // counts[name][yyyy-mm-dd] = n

  for (const c of commits) {
    const dt = new Date(c.created_at);
    // KST 보정(시트 날짜 헤더가 로컬이라면 중요)
    dt.setMinutes(dt.getMinutes() + cfg.timezoneOffsetMinutes);
    const day = dt.toISOString().split('T')[0];

    // 이메일/이름 매칭
    const email = (c.author_email || '').toLowerCase();
    const author = (c.author_name || '').trim();

    // memberMap의 키는 "시트 이름" (열 B의 값)이라고 가정
    const sheetNames = Object.keys(memberMap);
    for (const sheetName of sheetNames) {
      const m = memberMap[sheetName];
      const emailMatch = (m.emails || []).some(e => e.toLowerCase() === email);
      const nameMatch  = (m.names  || []).some(n => n === author);
      if (emailMatch || nameMatch) {
        counts[sheetName] ??= {};
        counts[sheetName][day] = (counts[sheetName][day] || 0) + 1;
        break;
      }
    }
  }
  return counts;
}

chrome.runtime.onMessage.addListener(async (msg, _sender, sendResponse) => {
  if (msg?.type !== 'RUN_COLLECT_AND_WRITE') return;

  try {
    const cfg = await getConfig();
    const allCommits = [];

    for (const repo of cfg.repos) {
      const pid = await getProjectId(repo, cfg);                   // :contentReference[oaicite:7]{index=7}
      const commits = await collectCommits(pid, cfg);              // :contentReference[oaicite:8]{index=8}
      allCommits.push(...commits);
    }

    const counts = aggregateByDateAndMember(allCommits, cfg, cfg.memberMap);

    // Apps Script로 전송
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

    if (!res.ok) throw new Error(`Apps Script write failed ${res.status}`);
    sendResponse({ ok: true });
  } catch (e) {
    console.error(e);
    sendResponse({ ok: false, error: String(e) });
  }
  return true; // async
});
