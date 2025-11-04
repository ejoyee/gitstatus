// 저장 키: background.js의 getConfig()와 호환됨
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { repos: [] };

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

  async function save() {
    const appsScriptUrl = $("appsScriptUrl").value.trim();
    const spreadsheetId = $("spreadsheetId").value.trim();
    const gitlabToken = $("gitlabToken").value.trim();

    if (!appsScriptUrl.includes("script.google.com")) return setStatus("시트 작성 코드 URL을 확인하세요.", true);
    if (!spreadsheetId) return setStatus("시트 ID를 입력하세요.", true);
    if (!gitlabToken) return setStatus("GitLab Token을 입력하세요.", true);
    if (state.repos.length === 0) return setStatus("Repos를 1개 이상 추가하세요.", true);

    // 공용 설정(sync)
    await chrome.storage.sync.set({
      appsScriptUrl,
      repos: state.repos,
      sheet: { spreadsheetId, sheetName: "주간 Git 현황", headerRow: 6, nameCol: 3 }
    });

    // 민감 토큰은 local(+호환을 위해 sync에도 복사 가능)
    await chrome.storage.local.set({ gitlabToken });
    await chrome.storage.sync.set({ gitlabToken });

    setStatus("✅ 저장 완료! 팝업을 닫아도 설정은 유지됩니다.");
  }

  function load() {
    chrome.storage.sync.get({
      appsScriptUrl: "",
      repos: [],
      sheet: { spreadsheetId: "", sheetName: "주간 Git 현황", headerRow: 6, nameCol: 3 }
    }, async (cfg) => {
      $("appsScriptUrl").value = cfg.appsScriptUrl || "";
      $("spreadsheetId").value = cfg.sheet?.spreadsheetId || "";
      state.repos = Array.isArray(cfg.repos) ? cfg.repos : [];

      const loc = await chrome.storage.local.get({ gitlabToken: "" });
      const syncTok = await chrome.storage.sync.get({ gitlabToken: "" });
      $("gitlabToken").value = loc.gitlabToken || syncTok.gitlabToken || "";

      renderChips();
    });
  }

  async function resetAll() {
    await chrome.storage.sync.remove(["appsScriptUrl","repos","sheet","gitlabToken"]);
    await chrome.storage.local.remove(["gitlabToken"]);
    state.repos = [];
    ["appsScriptUrl","spreadsheetId","gitlabToken"].forEach(id => $(id).value = "");
    renderChips();
    setStatus("초기화 완료. 다시 값을 입력해 주세요.");
  }

  function setStatus(msg, isErr=false) {
    const el = $("status");
    el.textContent = msg;
    el.className = "status " + (isErr ? "err" : "ok");
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"'`=\/]/g, (c) => ({
      "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;","/":"&#x2F;","`":"&#x60;","=":"&#x3D;"
    }[c]));
  }

  document.addEventListener("DOMContentLoaded", () => {
    load();
    bindRepoInput();
    $("saveBtn").addEventListener("click", save);
    $("resetBtn").addEventListener("click", resetAll);
  });
})();
