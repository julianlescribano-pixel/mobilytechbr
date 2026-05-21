const fs = require("fs/promises");
const path = require("path");

const PRODUCTS_FILE = path.join(process.cwd(), "data", "products.json");
const ADDONS_FILE = path.join(process.cwd(), "data", "addons.json");
const MERCADO_PAGO_API = "https://api.mercadopago.com/checkout/preferences";
const ADDON_CATEGORIES = {
  storage: "Armazenamento",
  peripherals: "Kit perifericos"
};

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
  if (typeof value === "number") return value;
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

async function loadGlobalAddons() {
  try {
    const addons = JSON.parse(await fs.readFile(ADDONS_FILE, "utf8"));
    return Array.isArray(addons) ? addons : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function normalizeAddonOption(option) {
  const label = option?.label || option?.name || "";
  const price = parsePriceBRL(option?.price);
  if (!option || option.active === false || !label || !Number.isFinite(price) || price <= 0) {
    return null;
  }
  return { ...option, label, price };
}

function productAddonGroups(product, globalAddons = []) {
  const source = product.addons || product.options || {};
  return Object.fromEntries(Object.keys(ADDON_CATEGORIES).map((category) => {
    const globalOptions = Array.isArray(globalAddons)
      ? globalAddons.filter((option) => option?.category === category)
      : [];
    const productOptions = Array.isArray(source[category]) ? source[category] : [];
    const activeOptions = [...globalOptions, ...productOptions]
      .map(normalizeAddonOption)
      .filter(Boolean);
    return [category, activeOptions];
  }));
}

function normalizeSelectedAddons(product, selectedAddons, globalAddons = []) {
  if (!Array.isArray(selectedAddons) || selectedAddons.length === 0) return [];

  const groups = productAddonGroups(product, globalAddons);
  const usedOptions = new Set();
  return selectedAddons.map((selection) => {
    const category = String(selection?.category || "");
    const index = Number(selection?.index);
    if (!ADDON_CATEGORIES[category]) {
      const error = new Error("Categoria de opcional invalida.");
      error.statusCode = 400;
      throw error;
    }
    const optionKey = `${category}:${index}`;
    if (usedOptions.has(optionKey)) {
      const error = new Error("Opcional repetido no checkout.");
      error.statusCode = 400;
      throw error;
    }
    usedOptions.add(optionKey);
    if (!Number.isInteger(index) || index < 0 || index >= groups[category].length) {
      const error = new Error("Opcional nao encontrado ou indisponivel.");
      error.statusCode = 400;
      throw error;
    }

    const option = groups[category][index];
    return {
      category,
      categoryLabel: ADDON_CATEGORIES[category],
      index,
      label: option.label,
      price: option.price
    };
  });
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
    const { productId, selectedAddons } = await readJsonBody(request);
    if (!productId) {
      sendJson(response, 400, { error: "Produto nao informado." });
      return;
    }

    const [products, globalAddons] = await Promise.all([
      loadProducts(),
      loadGlobalAddons()
    ]);
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

    const addons = normalizeSelectedAddons(product, selectedAddons, globalAddons);
    const origin = requestOrigin(request);
    const addonDescription = addons.map((addon) => `${addon.categoryLabel}: ${addon.label}`).join(" | ");
    const preference = {
      items: [
        {
          id: product.id,
          title: product.title,
          description: [product.tags?.filter(Boolean).join(" | "), addonDescription].filter(Boolean).join(" | ") || product.title,
          picture_url: absoluteUrl(origin, product.image || product.cutout),
          quantity: 1,
          currency_id: "BRL",
          unit_price: unitPrice
        },
        ...addons.map((addon) => ({
          id: `${product.id}-${addon.category}-${addon.index}`,
          title: `${addon.categoryLabel}: ${addon.label}`,
          quantity: 1,
          currency_id: "BRL",
          unit_price: addon.price
        }))
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
        product_title: product.title,
        selected_addons: addons.map((addon) => `${addon.category}:${addon.label}`).join("; ")
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
    sendJson(response, error.statusCode || 500, { error: error.message || "Erro ao criar checkout." });
  }
};
