// 저장 키: background.js의 getConfig()와 호환됨
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { repos: [] };

  // ✅ [ADD] 학생 매핑 상태
  let memberMap = {};      // { '공식이름': { names: ['별칭1','별칭2'], emails: [] } }
  let officialNames = [];  // 시트 C열 공식 이름 목록

  // { officialNames:[], teamsByName: { [name]: teamCode }, fetchedAt:number }
  const STUDENT_CACHE_KEY = 'studentCache';

  // ✅ [ADD] 섹션 전환
  function showPage(which) {
    const basic = $("page-basic");
    const students = $("page-students");
    if (!basic || !students) return;

    const toStudents = which === "students";
    basic.classList.toggle("hidden", toStudents);
    students.classList.toggle("hidden", !toStudents);

    // 기본 화면으로 돌아올 때 잔상 제거 & 스크롤 초기화
    if (!toStudents) {
      const wrap = $("students-wrap");
      if (wrap) wrap.innerHTML = "";
      document.documentElement.scrollTop = 0;
    }
  }


  // 캐시 읽기
  async function loadStudentCache() {
    const st = await chrome.storage.sync.get({ [STUDENT_CACHE_KEY]: null });
    const sm = await chrome.storage.sync.get({ memberMap: {} });
    memberMap = sm.memberMap || {};

    const cache = st[STUDENT_CACHE_KEY];
    if (cache && Array.isArray(cache.officialNames) && cache.officialNames.length) {
      officialNames = cache.officialNames;
      // ✅ teamsByName도 같이 들고 오기
      window._teamsByName = cache.teamsByName || {};
      return true;
    }
    return false;
  }

  async function saveStudentCache() {
    await chrome.storage.sync.set({
      [STUDENT_CACHE_KEY]: { officialNames, teamsByName: window._teamsByName || {}, fetchedAt: Date.now() }
    });
    await Promise.all([
      chrome.storage.local.set({ memberMap }),
      chrome.storage.sync.set({ memberMap }),
    ]);
  }


  function renderChips() {
    const wrap = $("repoChips");
    wrap.innerHTML = "";
    state.repos.forEach((r, idx) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.innerHTML = `<span>${escapeHtml(r)}</span><button aria-label="remove">&times;</button>`;
      chip.querySelector("button").addEventListener("click", () => {
        state.repos.splice(idx, 1);
        renderChips();
      });
      wrap.appendChild(chip);
    });
  }

  function bindRepoInput() {
    const input = $("repoInput");
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const val = input.value.trim();
      if (!val) return;

      const norm = (s) => {
        s = s.replace(/\s+/g, " ").trim();
        if (!s.startsWith("/")) s = "/" + s; // 필요시 시작 슬래시 보장
        return s;
      };

      val.replace(/\n/g, ",")
        .split(",")
        .map(norm)
        .filter(Boolean)
        .forEach((item) => { if (!state.repos.includes(item)) state.repos.push(item); });

      renderChips();
      input.value = "";
    });
  }

  // ===== CSV Export / Import =====
  function memberToRow(name) {
    const v = memberMap[name] || {};
    // 시트 팀 우선, 없으면 memberMap.team
    const team = (window._teamsByName?.[name] || v.team || '').trim();
    const aliases = Array.isArray(v.names) ? v.names.slice() : [];
    const emails = Array.isArray(v.emails) ? v.emails.slice() : [];
    return { name, team, aliases, emails };
  }

  function csvEscape(s) {
    const t = String(s ?? '');
    if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
  }

  function downloadMappingCSV() {
    // officialNames가 있으면 그 순서대로, 없으면 memberMap 키 정렬
    const names = officialNames?.length ? officialNames.slice()
      : Object.keys(memberMap).sort((a, b) => a.localeCompare(b, 'ko'));

    const lines = [];
    lines.push('name,team,aliases,emails');
    for (const nm of names) {
      const { name, team, aliases, emails } = memberToRow(nm);
      // aliases/emails는 보기 좋게 콤마로 join (가져오기에서는 , ; 둘 다 허용)
      const ali = aliases.join(', ');
      const em = emails.join(', ');
      lines.push(
        [name, team, ali, em].map(csvEscape).join(',')
      );
    }
    // UTF-8 BOM 붙여서 엑셀 한글 깨짐 방지
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `git-students-mapping-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function parseListField(s) {
    // 쉼표 또는 세미콜론 모두 구분자로 허용
    return String(s || '')
      .split(/[,;]/)
      .map(x => x.trim())
      .filter(Boolean);
  }

  async function importMappingCSVFromFile(file) {
    const text = await file.text();
    // 간단 파서: 첫 줄 헤더, 나머지 줄은 CSV
    // 큰따옴표 처리까지 고려한 안전 파싱을 위해 브라우저의 <textarea> split 대신 정규 기반
    // (실무라면 PapaParse 추천이지만, 확장 번들 크기 줄이려 내장 파서로 처리)
    function parseCSV(t) {
      const rows = [];
      let row = [];
      let cell = '';
      let inQ = false;

      for (let k = 0; k <= t.length; k++) {
        const ch = t[k] ?? '\n'; // 마지막 루프에서 강제 flush

        if (inQ) {
          if (ch === '"') {
            if (t[k + 1] === '"') { cell += '"'; k++; }
            else { inQ = false; }
          } else {
            cell += ch;
          }
          continue;
        }

        if (ch === '"') {
          inQ = true;
        } else if (ch === ',') {
          row.push(cell);
          cell = '';
        } else if (ch === '\n' || ch === '\r') {
          // 셀 종료
          row.push(cell);
          cell = '';

          // BOM 제거 + 임시 구분자 조립
          const joined = row.map(x => String(x).replace(/\uFEFF/g, '')).join('\x1F');
          row = [];

          // 빈 라인 스킵
          if (joined.replace(/\x1F/g, '').trim().length) {
            rows.push(joined.split('\x1F'));   // ← rows에는 '배열'을 넣음
          }

          // CRLF이면 \n에서만 처리하도록 \r 시점에 다음 글자 넘김
          if (ch === '\r' && t[k + 1] === '\n') k++;
        } else {
          cell += ch;
        }
      }

      // 이미 배열이므로 그대로 반환해야 함
      return rows;
    }


    const rows = parseCSV(text);
    if (!rows.length || !Array.isArray(rows[0])) {
      throw new Error('CSV 파싱 실패: 헤더 행을 읽지 못했습니다.');
    }



    // 헤더 인식 (순서 유연: name / team / aliases / emails)
    const header = rows[0].map(s => s.trim().toLowerCase());
    const idx = {
      name: header.indexOf('name'),
      team: header.indexOf('team'),
      aliases: header.indexOf('aliases'),
      emails: header.indexOf('emails'),
    };
    if (idx.name < 0) throw new Error('CSV에 name 컬럼이 없습니다.');

    // 병합 모드: 기존 memberMap에 덮어쓰기(동명이인 충돌은 이름 기준 1:1 가정)
    const importedNames = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || !row.length) continue;
      const name = (row[idx.name] || '').trim();
      if (!name) continue;

      const team = idx.team >= 0 ? (row[idx.team] || '').trim() : '';
      const aliases = idx.aliases >= 0 ? parseListField(row[idx.aliases]) : [];
      const emails = idx.emails >= 0 ? parseListField(row[idx.emails]) : [];

      // 엔트리 준비
      const entry = memberMap[name] ||= { team: '', names: [], emails: [] };

      // 팀: 명시돼 있으면 갱신
      if (team) entry.team = team;

      // 별칭/이메일: 중복 없이 합치기
      entry.names ||= [];
      entry.emails ||= [];
      for (const a of aliases) if (!entry.names.includes(a)) entry.names.push(a);
      for (const e of emails) if (!entry.emails.includes(e)) entry.emails.push(e);

      // 학생 캐시(팀 맵)도 보강
      window._teamsByName ||= {};
      if (team) window._teamsByName[name] = team;

      importedNames.push(name);
    }

    // officialNames 업데이트(가져온 순서 유지 + 기존에 있던 건 유지)
    const set = new Set(importedNames.concat(officialNames || []));
    officialNames = Array.from(set);

    // 저장
    await Promise.all([
      chrome.storage.sync.set({ memberMap }),
      chrome.storage.local.set({ memberMap }),
    ]);
    await chrome.storage.sync.set({
      studentCache: { officialNames, teamsByName: window._teamsByName || {}, fetchedAt: Date.now() }
    });

    // 1) 메모리 → UI 즉시 반영
    renderStudentEditor();
    updateStudentCount(officialNames.length);
    // 2) 학생 페이지가 아니면 곧바로 전환해서 확인 가능하게
    showPage("students");
    // 3) (선택) 저장까지 해두면 팝업 닫았다 열어도 유지
    await Promise.all([
      chrome.storage.sync.set({ memberMap }),
      chrome.storage.local.set({ memberMap }),
      chrome.storage.sync.set({
        studentCache: { officialNames, teamsByName: window._teamsByName || {}, fetchedAt: Date.now() }
      }),
    ]);
    setStatus(`CSV 가져오기 완료! (${importedNames.length}명 반영)`);
  }

  // 버튼 바인딩 (DOMContentLoaded 내부에 추가)
  document.addEventListener("DOMContentLoaded", () => {
    // ... 기존 바인딩들 ...
    $("btn-export-csv")?.addEventListener("click", () => {
      try {
        downloadMappingCSV();
        setStatus("CSV를 내려받았습니다.");
      } catch (e) {
        console.error(e);
        setStatus("CSV 내보내기에 실패했습니다.", true);
      }
    });

    $("btn-import-csv")?.addEventListener("click", () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,text/csv';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        setStatus("CSV 가져오는 중…");
        try {
          await importMappingCSVFromFile(file);
        } catch (e) {
          console.error(e);
          setStatus(`가져오기에 실패: ${e?.message || e}`, true);
        }
      };
      input.click();
    });
  });


  // ✅ [CHANGE] 설정 저장 시 memberMap까지 같이 저장
  async function save() {
    const appsScriptUrl = $("appsScriptUrl").value.trim();
    const spreadsheetId = $("spreadsheetId").value.trim();
    const gitlabToken = $("gitlabToken").value.trim();
    let days = parseInt($("days").value, 10);
    if (!Number.isFinite(days) || days < 1) days = 1; // 하한선 보정

    if (!appsScriptUrl.includes("script.google.com")) return setStatus("시트 작성 코드 URL을 확인하세요.", true);
    if (!spreadsheetId) return setStatus("시트 ID를 입력하세요.", true);
    if (!gitlabToken) return setStatus("GitLab Token을 입력하세요.", true);
    if (state.repos.length === 0) return setStatus("Repos를 1개 이상 추가하세요.", true);

    await chrome.storage.sync.set({
      appsScriptUrl,
      repos: state.repos,
      sheet: { spreadsheetId, sheetName: "주간 Git 현황", headerRow: 6, nameCol: 3 },
      memberMap,
      days
    });

    await chrome.storage.local.set({ gitlabToken }); // (원래대로 유지: 동기화 원치 않으면 제거)

    setStatus("✅ 저장 완료! 팝업을 닫아도 설정은 유지됩니다.");
  }

  // ✅ [CHANGE] 로드 시 memberMap 불러오고 카운트 표시
  function load() {
    chrome.storage.sync.get({
      appsScriptUrl: "",
      repos: [],
      sheet: { spreadsheetId: "", sheetName: "주간 Git 현황", headerRow: 6, nameCol: 3 },
      memberMap: {},
      days: 1
    }, async (cfg) => {
      $("appsScriptUrl").value = cfg.appsScriptUrl || "";
      $("spreadsheetId").value = cfg.sheet?.spreadsheetId || "";
      state.repos = Array.isArray(cfg.repos) ? cfg.repos : [];
      memberMap = cfg.memberMap || {};
      $("days").value = String(cfg.days ?? 1);

      Object.keys(memberMap).forEach(k => {
        const v = memberMap[k] ||= {};
        if (v.team === undefined) v.team = '';
        if (!Array.isArray(v.names)) v.names = [];
        if (!Array.isArray(v.emails)) v.emails = [];
      });

      const loc = await chrome.storage.local.get({ gitlabToken: "" });
      const syncTok = await chrome.storage.sync.get({ gitlabToken: "" });
      $("gitlabToken").value = loc.gitlabToken || syncTok.gitlabToken || "";

      renderChips();

      // 초기 카운트(공식 이름 수는 학생 화면 열 때 확정)
      updateStudentCount(Object.keys(memberMap).length);
    });
  }

  async function resetAll() {
    await chrome.storage.sync.remove(["appsScriptUrl", "repos", "sheet", "gitlabToken", "memberMap", STUDENT_CACHE_KEY]);
    state.repos = [];
    memberMap = {};
    ["appsScriptUrl", "spreadsheetId", "gitlabToken"].forEach(id => $(id).value = "");
    renderChips();
    updateStudentCount(0);
    setStatus("초기화 완료. 다시 값을 입력해 주세요.");
  }

  function setStatus(msg, isErr = false) {
    const el = $("status");
    if (!el) return;
    el.textContent = msg;
    el.className = "status " + (isErr ? "err" : "ok");
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"'`=\/]/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;", "/": "&#x2F;", "`": "&#x60;", "=": "&#x3D;"
    }[c]));
  }

  // ✅ [ADD] 카운트 표시 유틸
  function updateStudentCount(n) {
    const a = $("students-count");
    const b = $("students-count-2");
    if (a) a.textContent = n ? `(${n}명)` : "";
    if (b) b.textContent = n ? `(${n}명)` : "";
  }

  // =========================
  // 학생 이름 + 팀 코드 가져오기 (Apps Script)
  // =========================
  async function fetchOfficialRoster() {
    const appsScriptUrl = $("appsScriptUrl").value.trim();
    const spreadsheetId = $("spreadsheetId").value.trim();
    if (!appsScriptUrl || !spreadsheetId) throw new Error("시트 URL/ID를 먼저 저장하세요.");

    const res = await fetch(appsScriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "listNames",             // ★ 기존 모드명 그대로 사용해도 OK (Apps Script에서 함께 리턴)
        spreadsheetId,
        sheetName: "Git 평가 내용",
        headerSpec: { monthRow: 5, dayRow: 6, weekdayRow: 7, startDateCol: 6 }
      })
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "이름/팀 목록 조회 실패");
    return {
      names: json.names || [],
      teamsByName: json.teamsByName || {}  // ★ 추가
    };
  }


  // =========================
  // 학생 편집 화면 렌더링
  // =========================
  // =========================
  // 학생 편집 화면 렌더링 (팀 → 이름 정렬 + 팀 소제목으로 그룹핑)
  // =========================
  function renderStudentEditor() {
    const wrap = $("students-wrap");
    wrap.innerHTML = "";

    // 각 이름에 팀 주입(시트 팀 우선, 비어있으면 memberMap 팀)
    const getTeam = (n) =>
      (window._teamsByName?.[n] || "").trim() ||
      (memberMap[n]?.team || "").trim();

    // entries: [{name, team}]
    const entries = officialNames
      .slice()
      .map((name) => {
        if (!memberMap[name]) memberMap[name] = { team: "", names: [], emails: [] };
        return { name, team: getTeam(name) };
      });

    // 정렬: 팀 우선(빈 팀은 맨 뒤) → 팀 내 이름 오름차순
    entries.sort((a, b) => {
      const ta = a.team, tb = b.team;
      if (ta && !tb) return -1;
      if (!ta && tb) return 1;
      if (ta && tb) {
        const tcmp = ta.localeCompare(tb, "ko");
        if (tcmp !== 0) return tcmp;
      }
      return a.name.localeCompare(b.name, "ko");
    });

    // 그룹 헤더 스타일
    const headerCss =
      "margin:18px 0 8px;padding:6px 10px;border-radius:8px;" +
      "background:#f6f8fa;border:1px solid #e1e4e8;font-weight:1000; color:#333;";

    let currentTeam = undefined;

    for (const { name, team } of entries) {
      // 팀 변경 시 소제목 출력 (빈 팀은 '미배정')
      if (team !== currentTeam) {
        currentTeam = team;
        const h = document.createElement("div");
        h.className = "team-header";
        h.style.cssText = headerCss;
        h.textContent = team || "미배정";
        wrap.appendChild(h);
      }

      // 카드
      const box = document.createElement("div");
      box.style.cssText =
        "padding:10px;border:1px solid #eee;border-radius:10px;margin:8px 0;background:#fff";

      // 별칭 칩
      const chips = (memberMap[name].names || [])
        .map(
          (alias, idx) => `
        <span class="chip" style="background:#f6f8fa;border:1px solid #e1e4e8">
          ${escapeHtml(alias)}
          <button data-act="del" data-idx="${idx}" aria-label="삭제">✕</button>
        </span>`
        )
        .join("");

      // 팀 인풋 제거하고, 읽기용 뱃지로만 노출
      box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="font-weight:800">${escapeHtml(name)}</div>
        <span style="font-size:12px;padding:4px 8px;border-radius:999px;background:#eef6ff;border:1px solid #cfe3ff;color:#2563eb">
          ${escapeHtml(team || "미배정")}
        </span>
      </div>

      <div class="chips wg-alias-zone" style="min-height:36px;border:1px dashed #eee;padding:6px;border-radius:8px">
        ${chips}
        <!-- 클릭 시 인라인 입력 생성 -->
      </div>
    `;

      // 별칭 삭제/추가
      box.addEventListener("click", (e) => {
        const t = e.target;

        if (t.dataset.act === "del") {
          const idx = Number(t.dataset.idx);
          (memberMap[name].names ||= []).splice(idx, 1);
          renderStudentEditor();
          return;
        }

        const zone = t.closest(".wg-alias-zone");
        if (zone) {
          if (zone.querySelector(".wg-inp")) return;
          const inp = document.createElement("input");
          inp.type = "text";
          inp.className = "wg-inp";
          inp.placeholder = "별칭 입력 후 Enter";
          inp.style.cssText =
            "padding:6px 10px;border:1px solid #ddd;border-radius:8px;min-width:160px";
          zone.appendChild(inp);
          inp.focus();

          inp.addEventListener("keydown", (ke) => {
            if (ke.key === "Enter") {
              const val = (inp.value || "").trim();
              if (val) {
                const arr = (memberMap[name].names ||= []);
                if (!arr.includes(val)) arr.push(val);
              }
              renderStudentEditor();
            }
            if (ke.key === "Escape") {
              renderStudentEditor();
            }
          });
        }
      });

      wrap.appendChild(box);
    }

    updateStudentCount(entries.length);
  }


  // =========================
  // 이벤트 바인딩
  // =========================
  document.addEventListener("DOMContentLoaded", () => {
    load();
    bindRepoInput();
    $("saveBtn").addEventListener("click", save);
    $("resetBtn").addEventListener("click", resetAll);

    // ✅ 학생 페이지 열기(전체 화면 전환)
    // 학생 페이지 열기
    $("btn-open-students").addEventListener("click", async () => {
      setStatus("이름/팀 목록 불러오는 중…");
      const hasCache = await loadStudentCache();

      if (!hasCache) {
        try {
          const { names, teamsByName } = await fetchOfficialRoster();
          officialNames = names;
          window._teamsByName = teamsByName || {};

          // memberMap 보정 + 팀 자동 주입
          officialNames.forEach(n => {
            if (!memberMap[n]) memberMap[n] = { team: '', names: [], emails: [] };
            const t = (window._teamsByName || {})[n];
            if (t && !memberMap[n].team) memberMap[n].team = t; // ✅ 비어 있으면 넣어줌
          });

          await saveStudentCache();
        } catch (e) {
          console.error(e);
          setStatus("학생 정보를 불러오지 못했습니다. URL/ID 확인 후 다시 시도하세요.", true);
          $("students-wrap").innerHTML =
            `<div style="padding:14px;border:1px dashed #e9b; border-radius:8px; background:#fff">
           학생 정보가 없습니다. <b>설정 저장</b> 후 다시 시도하거나, 네트워크를 확인해 주세요.
         </div>`;
          showPage("students");
          return;
        }
      } else {
        // 캐시가 있으면 즉시 반영 (팀도 동일)
        officialNames.forEach(n => {
          if (!memberMap[n]) memberMap[n] = { team: '', names: [], emails: [] };
          const t = (window._teamsByName || {})[n];
          if (t && !memberMap[n].team) memberMap[n].team = t;  // ✅ 팀 비어 있으면 채워주기
        });
      }

      renderStudentEditor();
      updateStudentCount(officialNames.length);
      setStatus("");
      showPage("students");
    });


    $("btn-reload")?.addEventListener("click", async () => {
      try {
        setStatus("Apps Script에서 다시 불러오는 중…");
        const { names, teamsByName } = await fetchOfficialRoster();
        officialNames = names;
        window._teamsByName = teamsByName || {};
        officialNames.forEach(n => {
          if (!memberMap[n]) memberMap[n] = { team: '', names: [], emails: [] };
          // 팀 자동 주입(비어있을 때만)
          const t = (window._teamsByName || {})[n];
          if (t && !memberMap[n].team) memberMap[n].team = t;
          if (!Array.isArray(memberMap[n].names)) memberMap[n].names = [];
          if (!Array.isArray(memberMap[n].emails)) memberMap[n].emails = [];
        });
        await saveStudentCache();
        renderStudentEditor();
        updateStudentCount(officialNames.length);
        setStatus("새로 고침 완료!");
      } catch (e) {
        console.error(e);
        setStatus("재불러오기에 실패했습니다.", true);
      }
    });

    // ✅ 학생 페이지 → 이전 (기본 화면 복귀)
    $("btn-back").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showPage("basic");
    });


    // ✅ 학생 매핑 저장(이름 저장 버튼) — 바로 memberMap만 저장
    $("btn-save-students").addEventListener("click", () => {
      Promise.all([
        chrome.storage.sync.set({ memberMap }),
        chrome.storage.local.set({ memberMap }),
      ]).then(() => {
        setStatus("학생 이름 매핑 저장 완료!");
        showPage("basic");
      });
    });
  });
})();