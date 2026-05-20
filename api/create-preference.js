const fs = require("fs/promises");
const path = require("path");

const PRODUCTS_FILE = path.join(process.cwd(), "data", "products.json");
const MERCADO_PAGO_API = "https://api.mercadopago.com/checkout/preferences";

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body);

  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : {};
}

function parsePriceBRL(value) {
  const raw = String(value || "").replace(/[^\d,.-]/g, "");
  if (!raw) return NaN;

  if (raw.includes(",")) {
    return Number(raw.replace(/\./g, "").replace(",", "."));
  }

  const parts = raw.split(".");
  if (parts.length > 1 && parts[parts.length - 1].length === 3) {
    return Number(parts.join(""));
  }

  return Number(raw);
}

function requestOrigin(request) {
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  const protocol = request.headers["x-forwarded-proto"] || "https";
  return process.env.SITE_URL || `${protocol}://${host}`;
}

function absoluteUrl(origin, value) {
  if (!value) return undefined;
  if (/^https?:\/\//.test(value)) return value;
  return new URL(String(value).replace(/^\.\//, "/"), origin).toString();
}

async function loadProducts() {
  const products = JSON.parse(await fs.readFile(PRODUCTS_FILE, "utf8"));
  return Array.isArray(products) ? products : [];
}

module.exports = async function createPreference(request, response) {
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Metodo nao permitido." });
    return;
  }

  const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  if (!accessToken) {
    sendJson(response, 500, { error: "MERCADO_PAGO_ACCESS_TOKEN nao configurado na Vercel." });
    return;
  }

  try {
    const { productId } = await readJsonBody(request);
    if (!productId) {
      sendJson(response, 400, { error: "Produto nao informado." });
      return;
    }

    const products = await loadProducts();
    const product = products.find((item) => item.id === productId && item.active !== false);
    if (!product) {
      sendJson(response, 404, { error: "Produto nao encontrado ou inativo." });
      return;
    }

    const unitPrice = parsePriceBRL(product.price);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      sendJson(response, 400, { error: "Preco do produto invalido." });
      return;
    }

    const origin = requestOrigin(request);
    const preference = {
      items: [
        {
          id: product.id,
          title: product.title,
          description: product.tags?.filter(Boolean).join(" | ") || product.title,
          picture_url: absoluteUrl(origin, product.image || product.cutout),
          quantity: 1,
          currency_id: "BRL",
          unit_price: unitPrice
        }
      ],
      back_urls: {
        success: `${origin}/pagamento-sucesso.html`,
        pending: `${origin}/pagamento-pendente.html`,
        failure: `${origin}/pagamento-falha.html`
      },
      auto_return: "approved",
      external_reference: product.id,
      metadata: {
        product_id: product.id,
        product_title: product.title
      },
      statement_descriptor: "MOBILYTECHBR"
    };

    if (process.env.MERCADO_PAGO_WEBHOOK_URL) {
      preference.notification_url = process.env.MERCADO_PAGO_WEBHOOK_URL;
    }

    const mercadoPagoResponse = await fetch(MERCADO_PAGO_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(preference)
    });

    const data = await mercadoPagoResponse.json();
    if (!mercadoPagoResponse.ok) {
      sendJson(response, mercadoPagoResponse.status, {
        error: data.message || "Mercado Pago recusou a criacao do checkout.",
        details: data.error || data.cause
      });
      return;
    }

    const checkoutUrl = accessToken.startsWith("TEST-")
      ? data.sandbox_init_point || data.init_point
      : data.init_point || data.sandbox_init_point;

    sendJson(response, 200, {
      id: data.id,
      checkout_url: checkoutUrl
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Erro ao criar checkout." });
  }
};
