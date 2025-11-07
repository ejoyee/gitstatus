const log = (...a) => console.log('[GitCheck][bg]', ...a);
const warn = (...a) => console.warn('[GitCheck][bg]', ...a);
const err = (...a) => console.error('[GitCheck][bg]', ...a);

self.addEventListener('unhandledrejection', e => {
  console.error('[GitCheck][bg] unhandledrejection', e.reason);
});
self.addEventListener('error', e => {
  console.error('[GitCheck][bg] error', e.message, e.error);
});

// === Alias 매핑 유틸 ===
// cfg.memberMap: { "공식이름": { names: ["별칭1", ...], emails: [...], team?: string } }
// cfg.studentCache?.officialNames: ["공식이름", ...]
// === Alias 매핑 유틸 (이메일 보강 버전) ===
// memberMap: { "공식이름": { team?: string, names?: string[], emails?: string[] } }
// officialNames: ["공식이름", ...]

const normName = s => String(s || '').trim().toLowerCase();

function buildAliasIndex(memberMap = {}, officialNames = []) {
  const nameIdx = new Map();
  const emailIdx = new Map();

  (officialNames || []).forEach(n => {
    const k = String(n || '').trim();
    if (k) { nameIdx.set(k, k); nameIdx.set(normName(k), k); }
  });

  for (const [canonical, v] of Object.entries(memberMap || {})) {
    const can = String(canonical || '').trim();
    if (!can) continue;
    nameIdx.set(can, can);
    nameIdx.set(normName(can), can);

    (v?.names || []).forEach(a => {
      const key = String(a || '').trim();
      if (key) { nameIdx.set(key, can); nameIdx.set(normName(key), can); }
    });
    (v?.emails || []).forEach(e => {
      const em = String(e || '').trim().toLowerCase();
      if (em) emailIdx.set(em, can);
    });
  }
  return { nameIdx, emailIdx };
}

function canonicalizeName(authorName, authorEmail, aliasIdx) {
  const rawName = String(authorName || '').trim();
  const lowName = rawName.toLowerCase();
  const lowEmail = String(authorEmail || '').trim().toLowerCase();

  if (rawName && aliasIdx?.nameIdx?.has(rawName)) return aliasIdx.nameIdx.get(rawName);
  if (lowName && aliasIdx?.nameIdx?.has(lowName)) return aliasIdx.nameIdx.get(lowName);
  if (lowEmail && aliasIdx?.emailIdx?.has(lowEmail)) return aliasIdx.emailIdx.get(lowEmail);
  return rawName || '(unknown)';
}



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
        days: 1, // 기본: 오늘만
        timezoneOffsetMinutes: 9 * 60,
        studentCache: null
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
  const out = new Set();
  const perPage = 100;
  let page = 1;
  try {
    while (true) {
      const url = `https://${cfg.gitlabDomain}/api/v4/projects/${projectId}/repository/branches?per_page=${perPage}&page=${page}`;
      const res = await fetch(url, { headers: { 'PRIVATE-TOKEN': cfg.gitlabToken, 'Accept': 'application/json' } });
      if (!res.ok) {
        warn('getBranches failed, fallback main/master/develop', res.status);
        break;
      }
      const arr = await res.json();
      arr.forEach(b => out.add(b.name));
      if (arr.length < perPage) break;
      page++;
    }
    const names = Array.from(out);
    if (!names.length) return ['main', 'master', 'develop'];
    log('getBranches ok', { projectId, count: names.length, names: names.slice(0, 10) });
    return names;
  } catch (e) {
    err('getBranches exception, fallback', e);
    return ['main', 'master', 'develop'];
  }
}

async function collectCommits(projectId, cfg) {
  const n = Math.max(1, Number(cfg.days || 1));

  // KST 기준 하한(포함)
  const localStart = new Date();
  localStart.setHours(0, 0, 0, 0);               // 오늘 00:00 (로컬)
  localStart.setDate(localStart.getDate() - (n - 1)); // N-1일 전 00:00

  // KST 기준 상한(제외) = localStart + n일
  const localEnd = new Date(localStart);
  localEnd.setDate(localEnd.getDate() + n);

  // 그대로 ISO로 보내면 UTC로 해석됨 (추가 보정 불필요)
  const sinceIso = localStart.toISOString();
  const untilIso = localEnd.toISOString();

  // 로그
  log('collectCommits window', { projectId, sinceIso, untilIso });

  const branches = await getBranches(projectId, cfg);
  const perPage = 100;
  const all = [];

  for (const branch of branches) {
    let page = 1;
    while (true) {
      const url =
        `https://${cfg.gitlabDomain}/api/v4/projects/${projectId}/repository/commits?` +
        `since=${encodeURIComponent(sinceIso)}&until=${encodeURIComponent(untilIso)}&` +
        `ref_name=${encodeURIComponent(branch)}&per_page=${perPage}&page=${page}`;
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
        .filter(c => {
          const t = String(c.title || '');
          const looksMerge = /^merge\b/i.test(t);
          const multiParent = Array.isArray(c.parent_ids) && c.parent_ids.length > 1;
          return !(looksMerge || multiParent);
        })
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
function aggregateByDateAndMember(commits, cfg) {
  const counts = {}; // counts[canonical][yyyy-mm-dd] = n
  const aliasIdx = buildAliasIndex(
    cfg.memberMap || {},
    cfg.studentCache?.officialNames || []
  );

  log('aggregate start', {
    commits: commits.length,
    nameMapSize: aliasIdx.nameIdx?.size || 0,
    emailMapSize: aliasIdx.emailIdx?.size || 0
  });


  for (const c of commits) {
    const dt = new Date(c.created_at);
    dt.setMinutes(dt.getMinutes() + cfg.timezoneOffsetMinutes);
    const day = dt.toISOString().split('T')[0];

    const canonical = canonicalizeName(c.author_name, c.author_email, aliasIdx);
    (counts[canonical] ??= {});
    counts[canonical][day] = (counts[canonical][day] || 0) + 1;
  }

  const names = Object.keys(counts);
  log('aggregate done', {
    memberCount: names.length,
    sample: names.slice(0, 5).map(n => ({ name: n, days: Object.keys(counts[n]).length }))
  });
  return counts;
}


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

      /** ★ 전역 dedup(레포 간 중복 제거)
       *  - 프로젝트(레포) 내부 dedup는 collectCommits에서 했고,
       *  - 여기서는 여러 레포를 합친 allCommits 사이에서 같은 commitId를 한 번 더 제거합니다.
       */
      const seen = new Set();
      const uniqueCommits = [];
      for (const c of allCommits) {
        if (!c?.id) continue;
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        uniqueCommits.push(c);
      }
      log('dedup across repos', { before: allCommits.length, after: uniqueCommits.length });

      const counts = aggregateByDateAndMember(uniqueCommits, cfg);

      // === 사람별 원본 커밋 요약(사람 내부 중복 제거 + 날짜 정렬 + 팀정보) ===
      const aliasIdx = buildAliasIndex(cfg.memberMap || {}, cfg.studentCache?.officialNames || []);
      const perPerson = {}; // { canonical: { team:'', ids:Set, list:[{id,title,date,repo}] } }
      const teamsByName = (cfg.studentCache && cfg.studentCache.teamsByName) || {};

      for (const c of uniqueCommits) {
        const canonical = canonicalizeName(c.author_name, c.author_email, aliasIdx);
        const teamFromMemberMap = (cfg.memberMap?.[canonical]?.team) || '';
        const team = teamFromMemberMap || teamsByName[canonical] || '';  // ✅ 보강

        if (!perPerson[canonical]) perPerson[canonical] = { team, ids: new Set(), list: [] };
        // team을 최초 세팅 시점에 넣고, 이미 객체가 있다면 비어있을 때만 채움
        if (!perPerson[canonical].team && team) perPerson[canonical].team = team;

        const id = c.id;
        if (!id || perPerson[canonical].ids.has(id)) continue;
        perPerson[canonical].ids.add(id);
        perPerson[canonical].list.push({
          id,
          title: c.title,
          date: (c.created_at || '').slice(0, 10),
          repo: c.repo || ''
        });

        // (선택) 팀 디버깅: 여전히 팀이 없으면 경고
        if (!team) {
          warn('team missing for', canonical, {
            hasMemberKey: !!cfg.memberMap?.[canonical],
            byName: c.author_name,
            byEmail: (c.author_email || '').toLowerCase()
          });
        }
      }

      // 날짜 오름차순 정렬 (필요하면 b-a로 내림차순 바꿔)
      for (const k of Object.keys(perPerson)) {
        perPerson[k].list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      }

      // summary 재계산 (list.length 사용)
      const summary = Object.entries(perPerson)
        .map(([name, v]) => ({ team: v.team || '', name, count: v.list.length }))
        .sort((a, b) => (a.team || '').localeCompare(b.team || '') || a.name.localeCompare(b.name));

      // 미리보기(최대 20개)
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

