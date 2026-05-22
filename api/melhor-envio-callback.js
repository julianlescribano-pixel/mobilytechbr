const DEFAULT_AUTH_BASE = "https://www.melhorenvio.com.br";

function absoluteOrigin(request) {
  const proto = request.headers["x-forwarded-proto"] || "https";
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  return `${proto}://${host}`;
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_AUTH_BASE).trim().replace(/\/+$/, "");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sendHtml(response, status, html) {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.end(html);
}

function tokenPage(data) {
  const expiresInDays = data.expires_in ? Math.round(Number(data.expires_in) / 86400) : 30;

  return `<!doctype html>
  <html lang="pt-BR">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Token Melhor Envio - MobilyTechBR</title>
      <style>
        :root {
          color-scheme: dark;
          font-family: Arial, sans-serif;
          background: #06151d;
          color: #eef8ff;
        }
        body {
          margin: 0;
          min-height: 100vh;
          display: grid;
          place-items: center;
          padding: 24px;
        }
        main {
          width: min(860px, 100%);
          border: 1px solid rgba(39, 184, 255, 0.38);
          border-radius: 18px;
          background: #071d2a;
          padding: clamp(22px, 4vw, 40px);
          box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
        }
        h1 { margin: 0 0 10px; font-size: clamp(28px, 5vw, 44px); }
        p { color: #b9d7e8; line-height: 1.6; }
        label {
          display: block;
          margin-top: 22px;
          color: #31c7ff;
          font-weight: 800;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          font-size: 13px;
        }
        textarea {
          width: 100%;
          min-height: 118px;
          margin-top: 8px;
          box-sizing: border-box;
          border-radius: 12px;
          border: 1px solid rgba(49, 199, 255, 0.38);
          background: #020c12;
          color: #eef8ff;
          padding: 14px;
          font-family: Consolas, Monaco, monospace;
          font-size: 13px;
          resize: vertical;
        }
        .warning {
          border-left: 4px solid #ffd166;
          background: rgba(255, 209, 102, 0.1);
          padding: 12px 14px;
          border-radius: 10px;
          color: #ffe7a8;
          margin-top: 18px;
        }
        code {
          color: #75e7ff;
          background: rgba(117, 231, 255, 0.12);
          border-radius: 6px;
          padding: 2px 6px;
        }
      </style>
    </head>
    <body>
      <main>
        <h1>Token gerado</h1>
        <p>Copie o <strong>access token</strong> para a variavel <code>MELHOR_ENVIO_TOKEN</code> na Vercel. Ele vence em aproximadamente ${escapeHtml(expiresInDays)} dias.</p>
        <div class="warning">Nao compartilhe estes tokens em print, chat ou repositorio. Depois de salvar na Vercel, feche esta aba.</div>

        <label for="access-token">Access token</label>
        <textarea id="access-token" readonly>${escapeHtml(data.access_token)}</textarea>

        <label for="refresh-token">Refresh token</label>
        <textarea id="refresh-token" readonly>${escapeHtml(data.refresh_token)}</textarea>

        <p>Tambem salve o refresh token em <code>MELHOR_ENVIO_REFRESH_TOKEN</code> se quiser renovar o acesso depois sem recriar a autorizacao.</p>
      </main>
    </body>
  </html>`;
}

module.exports = async function melhorEnvioCallback(request, response) {
  const { code, error, error_description: errorDescription } = request.query || {};

  if (error) {
    sendHtml(response, 400, `
      <h1>Autorizacao recusada</h1>
      <p>${escapeHtml(errorDescription || error)}</p>
    `);
    return;
  }

  if (!code) {
    sendHtml(response, 400, `
      <h1>Codigo ausente</h1>
      <p>O Melhor Envio nao retornou o parametro <code>code</code>.</p>
    `);
    return;
  }

  const clientId = String(process.env.MELHOR_ENVIO_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.MELHOR_ENVIO_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) {
    sendHtml(response, 500, `
      <h1>Credenciais ausentes</h1>
      <p>Configure <strong>MELHOR_ENVIO_CLIENT_ID</strong> e <strong>MELHOR_ENVIO_CLIENT_SECRET</strong> na Vercel antes de concluir a autorizacao.</p>
    `);
    return;
  }

  const authBase = normalizeBaseUrl(process.env.MELHOR_ENVIO_AUTH_BASE);
  const redirectUri = String(process.env.MELHOR_ENVIO_REDIRECT_URI || `${absoluteOrigin(request)}/api/melhor-envio-callback`).trim();

  try {
    const tokenResponse = await fetch(`${authBase}/oauth/token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": process.env.MELHOR_ENVIO_USER_AGENT || "MobilyTechBR (mobilytechbr@gmail.com)"
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: Number(clientId) || clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code
      })
    });

    const data = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok) {
      sendHtml(response, tokenResponse.status, `
        <h1>Falha ao gerar token</h1>
        <p>${escapeHtml(data.message || data.error_description || "O Melhor Envio recusou a solicitacao.")}</p>
        <pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>
      `);
      return;
    }

    sendHtml(response, 200, tokenPage(data));
  } catch (error) {
    sendHtml(response, 500, `
      <h1>Erro na autorizacao</h1>
      <p>${escapeHtml(error.message || "Nao foi possivel falar com o Melhor Envio.")}</p>
    `);
  }
};
