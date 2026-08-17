export function renderOperatorLoginPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Deployment setup</title>
  <style>
    :root { color-scheme: light; --bg: #fbfbfa; --surface: #fff; --text: #111110; --muted: #70706d; --line: #e7e7e4; --danger: #9b3028; }
    * { box-sizing: border-box; }
    body { min-block-size: 100vh; min-block-size: 100svh; margin: 0; display: grid; place-items: center; padding: 1.5rem; background: var(--bg); color: var(--text); font: 1rem/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { inline-size: min(100%, 27rem); padding: clamp(1.5rem, 6vw, 2.5rem); border: 0.0625rem solid var(--line); border-radius: 0.75rem; background: var(--surface); }
    h1 { margin: 0 0 0.65rem; font-size: clamp(1.8rem, 7vw, 2.5rem); line-height: 1.1; letter-spacing: -0.035em; }
    p { margin: 0 0 1.5rem; color: var(--muted); }
    form { display: grid; gap: 0.85rem; }
    label { font-weight: 650; }
    input { inline-size: 100%; min-block-size: 3rem; padding: 0.7rem 0.8rem; border: 0.0625rem solid var(--line); border-radius: 0.4rem; color: var(--text); font: inherit; }
    input:focus-visible, button:focus-visible { outline: 0.2rem solid var(--text); outline-offset: 0.15rem; }
    button { min-block-size: 3rem; border: 0; border-radius: 999rem; background: var(--text); color: white; font: inherit; font-weight: 650; cursor: pointer; }
    button[disabled] { cursor: wait; opacity: 0.65; }
    #login-error { min-block-size: 1.5rem; margin: 0; color: var(--danger); }
  </style>
</head>
<body>
  <main>
    <h1>Deployment setup</h1>
    <p>Enter the private code from your service environment.</p>
    <form id="operator-login" autocomplete="off">
      <label for="setup-secret">Deployment setup code</label>
      <input id="setup-secret" name="setupSecret" type="password" required autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="login-error">
      <button type="submit">Continue</button>
      <p id="login-error" role="alert" aria-live="polite"></p>
    </form>
  </main>
  <script src="/agent/operator-login.js" defer></script>
</body>
</html>`;
}

export function renderOperatorLoginScript(): string {
  return `(() => {
  const form = document.getElementById("operator-login");
  const input = document.getElementById("setup-secret");
  const button = form && form.querySelector('button[type="submit"]');
  const error = document.getElementById("login-error");
  if (!form || !input || !button || !error) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    let setupSecret = input.value;
    input.value = "";
    button.disabled = true;
    button.textContent = "Checking…";
    form.setAttribute("aria-busy", "true");
    input.removeAttribute("aria-invalid");
    error.textContent = "";
    try {
      const response = await fetch("/api/operator/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setupSecret })
      });
      if (response.ok) {
        window.location.replace("/agent/dashboard");
        return;
      }
      error.textContent = response.status === 429
        ? "Too many attempts. Wait before trying again."
        : "That setup code was not accepted.";
      input.setAttribute("aria-invalid", "true");
    } catch {
      error.textContent = "Setup could not be reached. Try again.";
      input.setAttribute("aria-invalid", "true");
    } finally {
      setupSecret = "";
      button.disabled = false;
      button.textContent = "Continue";
      form.removeAttribute("aria-busy");
      input.focus();
    }
  });
})();`;
}
