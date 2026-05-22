const DEFAULT_AUTH_BASE = "https://www.melhorenvio.com.br";
const DEFAULT_SCOPES = [
  "cart-read",
  "cart-write",
  "orders-read",
  "shipping-calculate",
  "shipping-checkout",
  "shipping-generate",
  "shipping-print",
  "shipping-tracking",
  "users-read"
];

function absoluteOrigin(request) {
  const proto = request.headers["x-forwarded-proto"] || "https";
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  return `${proto}://${host}`;
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_AUTH_BASE).trim().replace(/\/+$/, "");
}

function sendHtml(response, status, html) {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.end(html);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = async function melhorEnvioAuthorize(request, response) {
  const clientId = String(process.env.MELHOR_ENVIO_CLIENT_ID || "").trim();
  if (!clientId) {
    sendHtml(response, 500, `
      <h1>Client ID ausente</h1>
      <p>Adicione <strong>MELHOR_ENVIO_CLIENT_ID</strong> nas variaveis de ambiente da Vercel antes de autorizar.</p>
    `);
    return;
  }

  const authBase = normalizeBaseUrl(process.env.MELHOR_ENVIO_AUTH_BASE);
  const redirectUri = String(process.env.MELHOR_ENVIO_REDIRECT_URI || `${absoluteOrigin(request)}/api/melhor-envio-callback`).trim();
  const scope = String(process.env.MELHOR_ENVIO_SCOPES || DEFAULT_SCOPES.join(" ")).trim();
  const state = String(process.env.MELHOR_ENVIO_OAUTH_STATE || "mobilytechbr").trim();

  const authorizeUrl = new URL("/oauth/authorize", authBase);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("scope", scope);

  if (request.query?.preview === "1") {
    sendHtml(response, 200, `
      <!doctype html>
      <html lang="pt-BR">
        <meta charset="utf-8">
        <title>Autorizar Melhor Envio</title>
        <body style="font-family: Arial, sans-serif; padding: 32px; line-height: 1.5;">
          <h1>Autorizar Melhor Envio</h1>
          <p>Confira se esta URL de callback esta igual a cadastrada no app:</p>
          <p><code>${escapeHtml(redirectUri)}</code></p>
          <p><a href="${escapeHtml(authorizeUrl.toString())}">Continuar para o Melhor Envio</a></p>
        </body>
      </html>
    `);
    return;
  }

  response.statusCode = 302;
  response.setHeader("Location", authorizeUrl.toString());
  response.end();
};
