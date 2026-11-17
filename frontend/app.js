/* Serverless Expense Tracker - frontend sem frameworks.
 * Autenticacao: chamadas diretas a API publica do Cognito (sem SDK).
 * Dados: HTTP API protegida por autorizador JWT do Cognito.
 */
(() => {
  "use strict";

  const CFG = window.APP_CONFIG || {};
  const CATEGORIES = {
    alimentacao: "Alimentação", transporte: "Transporte", moradia: "Moradia",
    saude: "Saúde", lazer: "Lazer", educacao: "Educação", compras: "Compras",
    contas: "Contas", outros: "Outros",
  };
  const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const $ = (sel) => document.querySelector(sel);

  // ------------------------------------------------------------ sessao
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* sem storage */ } },
    clear() { try { sessionStorage.clear(); } catch { /* sem storage */ } },
  };

  function jwtPayload(token) {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(b64))));
  }

  // ------------------------------------------------------------ Cognito
  async function cognito(action, body) {
    const res = await fetch(`https://cognito-idp.${CFG.region}.amazonaws.com/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": `AWSCognitoIdentityProviderService.${action}`,
      },
      body: JSON.stringify({ ClientId: CFG.userPoolClientId, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(translateCognitoError(data));
      err.code = (data.__type || "").split("#").pop();
      throw err;
    }
    return data;
  }

  function translateCognitoError(data) {
    const type = (data.__type || "").split("#").pop();
    return ({
      NotAuthorizedException: "E-mail ou senha incorretos.",
      UserNotConfirmedException: "Confirme seu e-mail antes de entrar.",
      UsernameExistsException: "Já existe uma conta com este e-mail.",
      InvalidPasswordException: "A senha não atende aos requisitos.",
      CodeMismatchException: "Código inválido.",
      ExpiredCodeException: "Código expirado. Peça um novo.",
      LimitExceededException: "Muitas tentativas. Aguarde um pouco.",
      TooManyRequestsException: "Muitas tentativas. Aguarde um pouco.",
    })[type] || data.message || "Algo deu errado. Tente novamente.";
  }

  function saveTokens(result) {
    store.set("idToken", result.IdToken);
    if (result.RefreshToken) store.set("refreshToken", result.RefreshToken);
  }

  async function validIdToken() {
    const token = store.get("idToken");
    if (token && jwtPayload(token).exp * 1000 > Date.now() + 60_000) return token;
    const refresh = store.get("refreshToken");
    if (!refresh) return null;
    try {
      const { AuthenticationResult } = await cognito("InitiateAuth", {
        AuthFlow: "REFRESH_TOKEN_AUTH",
        AuthParameters: { REFRESH_TOKEN: refresh },
      });
      saveTokens(AuthenticationResult);
      return AuthenticationResult.IdToken;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ API
  async function api(path, options = {}) {
    const token = await validIdToken();
    if (!token) { logout(); throw new Error("Sessão expirada."); }
    const res = await fetch(CFG.apiUrl + path, {
      ...options,
      headers: { Authorization: token, "Content-Type": "application/json" },
    });
    if (res.status === 401) { logout(); throw new Error("Sessão expirada."); }
    const data = res.status === 204 ? null : await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || "Erro ao falar com a API.");
    return data;
  }

  // ------------------------------------------------------------ telas de auth
  let pendingEmail = "";

  function showForm(id) {
    for (const f of ["login-form", "signup-form", "confirm-form"]) $(`#${f}`).hidden = f !== id;
    authMsg("");
  }
  function authMsg(text, ok = false) {
    const el = $("#auth-msg");
    el.textContent = text;
    el.classList.toggle("ok", ok);
  }
  async function busy(form, fn) {
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; }
  }

  document.querySelectorAll("[data-show]").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); showForm(a.dataset.show); }));

  $("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    busy(f, async () => {
      try {
        const { AuthenticationResult } = await cognito("InitiateAuth", {
          AuthFlow: "USER_PASSWORD_AUTH",
          AuthParameters: { USERNAME: f.email.value.trim(), PASSWORD: f.password.value },
        });
        saveTokens(AuthenticationResult);
        f.reset();
        start();
      } catch (err) {
        if (err.code === "UserNotConfirmedException") {
          pendingEmail = f.email.value.trim();
          $("#confirm-email").textContent = pendingEmail;
          await cognito("ResendConfirmationCode", { Username: pendingEmail }).catch(() => {});
          showForm("confirm-form");
        }
        authMsg(err.message);
      }
    });
  });

  $("#signup-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    busy(f, async () => {
      try {
        pendingEmail = f.email.value.trim();
        await cognito("SignUp", {
          Username: pendingEmail,
          Password: f.password.value,
          UserAttributes: [{ Name: "email", Value: pendingEmail }],
        });
        $("#confirm-email").textContent = pendingEmail;
        f.reset();
        showForm("confirm-form");
      } catch (err) { authMsg(err.message); }
    });
  });

  $("#confirm-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    busy(f, async () => {
      try {
        await cognito("ConfirmSignUp", { Username: pendingEmail, ConfirmationCode: f.code.value.trim() });
        f.reset();
        showForm("login-form");
        $("#login-form").email.value = pendingEmail;
        authMsg("Conta confirmada! Agora é só entrar.", true);
      } catch (err) { authMsg(err.message); }
    });
  });

  $("#resend-code").addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      await cognito("ResendConfirmationCode", { Username: pendingEmail });
      authMsg("Novo código enviado.", true);
    } catch (err) { authMsg(err.message); }
  });

  function logout() {
    store.clear();
    $("#app-view").hidden = true;
    $("#auth-view").hidden = false;
    showForm("login-form");
  }
  $("#logout").addEventListener("click", logout);

  // ------------------------------------------------------------ app
  let month = new Date().toISOString().slice(0, 7);
  let expenses = [];
  let editingId = null;

  const form = $("#expense-form");
  form.category.innerHTML = Object.entries(CATEGORIES)
    .map(([v, l]) => `<option value="${v}">${l}</option>`).join("");

  function shiftMonth(delta) {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    load();
  }
  $("#prev-month").addEventListener("click", () => shiftMonth(-1));
  $("#next-month").addEventListener("click", () => shiftMonth(1));

  function defaultDate() {
    const today = new Date().toISOString().slice(0, 10);
    return today.startsWith(month) ? today : `${month}-01`;
  }

  async function load() {
    const [y, m] = month.split("-").map(Number);
    $("#month-label").textContent = new Date(y, m - 1, 1)
      .toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
    if (!editingId) form.date.value = defaultDate();
    try {
      const [list, sum] = await Promise.all([
        api(`/expenses?month=${month}`),
        api(`/summary?month=${month}`),
      ]);
      expenses = list.items;
      renderSummary(sum);
      renderList();
    } catch (err) { formMsg(err.message); }
  }

  function renderSummary(sum) {
    $("#total").textContent = BRL.format(sum.total);
    $("#count").textContent = sum.count === 1 ? "1 despesa" : `${sum.count} despesas`;
    const ul = $("#categories");
    ul.replaceChildren();
    for (const [cat, value] of Object.entries(sum.byCategory)) {
      const li = document.createElement("li");
      const pct = sum.total ? (value / sum.total) * 100 : 0;
      li.innerHTML = `<span></span><span class="num"></span><div class="bar"><i></i></div>`;
      li.children[0].textContent = CATEGORIES[cat] || cat;
      li.children[1].textContent = `${BRL.format(value)} · ${pct.toFixed(0)}%`;
      li.querySelector("i").style.width = `${pct}%`;
      ul.append(li);
    }
  }

  function renderList() {
    const ul = $("#expense-list");
    ul.replaceChildren();
    $("#empty").hidden = expenses.length > 0;
    for (const exp of expenses) {
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="date-chip"></span>
        <span class="desc"><strong></strong><small></small></span>
        <span class="amount"></span>
        <span class="row-actions">
          <button class="btn link" data-act="edit">Editar</button>
          <button class="btn link danger" data-act="delete">Excluir</button>
        </span>`;
      const [, mm, dd] = exp.date.split("-");
      li.querySelector(".date-chip").textContent = `${dd}/${mm}`;
      li.querySelector("strong").textContent = exp.description;   // textContent evita XSS
      li.querySelector("small").textContent = CATEGORIES[exp.category] || exp.category;
      li.querySelector(".amount").textContent = BRL.format(exp.amount);
      li.querySelector("[data-act=edit]").addEventListener("click", () => startEdit(exp));
      li.querySelector("[data-act=delete]").addEventListener("click", () => remove(exp));
      ul.append(li);
    }
  }

  function formMsg(text, ok = false) {
    const el = $("#form-msg");
    el.textContent = text;
    el.classList.toggle("ok", ok);
  }

  function startEdit(exp) {
    editingId = exp.id;
    form.description.value = exp.description;
    form.amount.value = exp.amount;
    form.date.value = exp.date;
    form.category.value = exp.category;
    $("#form-title").textContent = "Editar despesa";
    $("#save-btn").textContent = "Salvar";
    $("#cancel-edit").hidden = false;
    form.description.focus();
  }

  function stopEdit() {
    editingId = null;
    form.reset();
    form.date.value = defaultDate();
    $("#form-title").textContent = "Nova despesa";
    $("#save-btn").textContent = "Adicionar";
    $("#cancel-edit").hidden = true;
  }
  $("#cancel-edit").addEventListener("click", stopEdit);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(form, async () => {
      const payload = {
        description: form.description.value.trim(),
        amount: Number(form.amount.value),
        date: form.date.value,
        category: form.category.value,
      };
      try {
        if (editingId) {
          await api(`/expenses/${encodeURIComponent(editingId)}`, { method: "PUT", body: JSON.stringify(payload) });
          formMsg("Despesa atualizada.", true);
        } else {
          await api("/expenses", { method: "POST", body: JSON.stringify(payload) });
          formMsg("Despesa adicionada.", true);
        }
        stopEdit();
        if (!payload.date.startsWith(month)) month = payload.date.slice(0, 7);
        load();
      } catch (err) { formMsg(err.message); }
    });
  });

  async function remove(exp) {
    if (!confirm(`Excluir "${exp.description}"?`)) return;
    try {
      await api(`/expenses/${encodeURIComponent(exp.id)}`, { method: "DELETE" });
      if (editingId === exp.id) stopEdit();
      formMsg("Despesa excluída.", true);
      load();
    } catch (err) { formMsg(err.message); }
  }

  // ------------------------------------------------------------ inicio
  async function start() {
    const token = await validIdToken();
    if (!token) return logout();
    $("#user-email").textContent = jwtPayload(token).email || "";
    $("#auth-view").hidden = true;
    $("#app-view").hidden = false;
    load();
  }

  if (!CFG.apiUrl) {
    document.body.innerHTML = "<p style='padding:2rem'>config.js ausente. Rode o script de deploy.</p>";
  } else {
    start();
  }
})();
