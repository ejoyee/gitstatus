// 저장 키: background.js의 getConfig()와 호환되도록 맞춰둠
// - appsScriptUrl, sheet.spreadsheetId, gitlabToken, repos[]
// - gitlabToken은 보안상 local에도 저장하고, sync에도 복사(호환용)
//   => background가 어디서든 읽을 수 있게.

(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    repos: [] // 문자열 배열
  };

  // chips 렌더
  function renderChips() {
    const wrap = $("repoChips");
    wrap.innerHTML = "";
    state.repos.forEach((r, idx) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.innerHTML = `
        <span>${escapeHtml(r)}</span>
        <button aria-label="remove">&times;</button>
      `;
      chip.querySelector("button").addEventListener("click", () => {
        state.repos.splice(idx, 1);
        renderChips();
      });
      wrap.appendChild(chip);
    });
  }

  // Enter로 repo 추가
  function bindRepoInput() {
    const input = $("repoInput");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const val = input.value.trim();
        if (val) {
          const norm = (s) => {
            s = s.replace(/\s+/g, ' ').trim();
            if (!s.startsWith('/')) s = '/' + s;  // 슬래시 보장 (선택)
            return s;
          };
          val
            .replace(/\n/g, ',')                    // 여러 줄 → 쉼표로
            .split(',')                             // 쉼표 기준 분할
            .map(s => norm(s))                      // 공백 정리 + "/" 보장
            .filter(Boolean)                        // 빈 문자열 제거
            .forEach((item) => {
              if (!state.repos.includes(item)) state.repos.push(item);
            });
          renderChips();
          input.value = "";
        }
      }
    });
  }

  // 저장
  async function save() {
    const appsScriptUrl = $("appsScriptUrl").value.trim();
    const spreadsheetId = $("spreadsheetId").value.trim();
    const gitlabToken = $("gitlabToken").value.trim();

    // Jira 관련 추가
    const jiraDomain = $("jiraDomain").value.trim();
    const jiraEmail = $("jiraEmail").value.trim();
    const jiraToken = $("jiraToken").value.trim();

    if (!appsScriptUrl.includes("script.google.com")) return setStatus("시트 작성 코드 URL을 확인하세요.", true);
    if (!spreadsheetId) return setStatus("시트 ID를 입력하세요.", true);
    if (!gitlabToken) return setStatus("GitLab Token을 입력하세요.", true);
    if (!jiraDomain || !jiraEmail || !jiraToken) return setStatus("Jira 정보를 모두 입력하세요.", true);
    if (state.repos.length === 0) return setStatus("Repos를 1개 이상 추가하세요.", true);

    await chrome.storage.sync.set({
      appsScriptUrl,
      repos: state.repos,
      sheet: {
        spreadsheetId,
        sheetName: "주간 Git 현황",
        headerRow: 6,
        nameCol: 3
      },
      jira: {
        domain: jiraDomain,
        email: jiraEmail
      }
    });

    // 민감 토큰은 local에 별도로
    await chrome.storage.local.set({ gitlabToken, jiraToken });
    await chrome.storage.sync.set({ gitlabToken }); // 호환용 (선택)

    setStatus("✅ 저장 완료! GitLab & Jira 설정이 저장되었습니다.");
  }


  // 로드
  function load() {
    chrome.storage.sync.get({
      appsScriptUrl: "",
      repos: [],
      sheet: { spreadsheetId: "", sheetName: "주간 Git 현황", headerRow: 6, nameCol: 3 }
    }, async (cfg) => {
      $("appsScriptUrl").value = cfg.appsScriptUrl || "";
      $("spreadsheetId").value = cfg.sheet?.spreadsheetId || "";
      state.repos = Array.isArray(cfg.repos) ? cfg.repos : [];

      // token은 local 우선
      const loc = await chrome.storage.local.get({ gitlabToken: "" });
      $("gitlabToken").value = loc.gitlabToken || (await chrome.storage.sync.get({ gitlabToken: "" })).gitlabToken || "";

      renderChips();
    });
  }

  // 재설정
  async function resetAll() {
    await chrome.storage.sync.remove(["appsScriptUrl", "repos", "sheet", "gitlabToken"]);
    await chrome.storage.local.remove(["gitlabToken"]);
    state.repos = [];
    $("appsScriptUrl").value = "";
    $("spreadsheetId").value = "";
    $("gitlabToken").value = "";
    renderChips();
    setStatus("초기화 완료. 다시 값을 입력해 주세요.");
  }

  function setStatus(msg, isErr = false) {
    const el = $("status");
    el.textContent = msg;
    el.className = "status " + (isErr ? "err" : "ok");
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"'`=\/]/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;", "/": "&#x2F;", "`": "&#x60;", "=": "&#x3D;"
    }[c]));
  }

  // init
  document.addEventListener("DOMContentLoaded", () => {
    load();
    bindRepoInput();
    $("saveBtn").addEventListener("click", save);
    $("resetBtn").addEventListener("click", resetAll);
  });
})();
