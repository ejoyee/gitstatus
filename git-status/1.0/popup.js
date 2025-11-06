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
    $("page-basic").style.display = (which === "basic") ? "" : "none";
    $("page-students").style.display = (which === "students") ? "" : "none";
  }

  // 캐시 읽기
  async function loadStudentCache() {
    const st = await chrome.storage.sync.get({ [STUDENT_CACHE_KEY]: null, memberMap: {} });
    memberMap = st.memberMap || {};
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
      [STUDENT_CACHE_KEY]: {
        officialNames,
        teamsByName: window._teamsByName || {},  // ✅ 추가
        fetchedAt: Date.now()
      },
      memberMap
    });
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

  // ✅ [CHANGE] 설정 저장 시 memberMap까지 같이 저장
  async function save() {
    const appsScriptUrl = $("appsScriptUrl").value.trim();
    const spreadsheetId = $("spreadsheetId").value.trim();
    const gitlabToken = $("gitlabToken").value.trim();

    if (!appsScriptUrl.includes("script.google.com")) return setStatus("시트 작성 코드 URL을 확인하세요.", true);
    if (!spreadsheetId) return setStatus("시트 ID를 입력하세요.", true);
    if (!gitlabToken) return setStatus("GitLab Token을 입력하세요.", true);
    if (state.repos.length === 0) return setStatus("Repos를 1개 이상 추가하세요.", true);

    await chrome.storage.sync.set({
      appsScriptUrl,
      repos: state.repos,
      sheet: { spreadsheetId, sheetName: "주간 Git 현황", headerRow: 6, nameCol: 3 },
      memberMap, // ✅ 함께 저장
    });

    await chrome.storage.local.set({ gitlabToken });
    await chrome.storage.sync.set({ gitlabToken });

    setStatus("✅ 저장 완료! 팝업을 닫아도 설정은 유지됩니다.");
  }

  // ✅ [CHANGE] 로드 시 memberMap 불러오고 카운트 표시
  function load() {
    chrome.storage.sync.get({
      appsScriptUrl: "",
      repos: [],
      sheet: { spreadsheetId: "", sheetName: "주간 Git 현황", headerRow: 6, nameCol: 3 },
      memberMap: {}
    }, async (cfg) => {
      $("appsScriptUrl").value = cfg.appsScriptUrl || "";
      $("spreadsheetId").value = cfg.sheet?.spreadsheetId || "";
      state.repos = Array.isArray(cfg.repos) ? cfg.repos : [];
      memberMap = cfg.memberMap || {};

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
        sheetName: "주간 Git 현황",
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
    "background:#f6f8fa;border:1px solid #e1e4e8;font-weight:800;color:#333;";

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
    $("btn-back").addEventListener("click", () => {
      showPage("basic");
    });

    // ✅ 학생 매핑 저장(이름 저장 버튼) — 바로 memberMap만 저장
    $("btn-save-students").addEventListener("click", () => {
      chrome.storage.sync.set({ memberMap }, () => {
        setStatus("학생 이름 매핑 저장 완료!");
        showPage("basic");
      });
    });
  });
})();