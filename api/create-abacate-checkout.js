const fs = require("fs/promises");
const path = require("path");

const PRODUCTS_FILE = path.join(process.cwd(), "data", "products.json");
const ADDONS_FILE = path.join(process.cwd(), "data", "addons.json");
const ABACATE_PRODUCTS_CREATE_API = "https://api.abacatepay.com/v2/products/create";
const ABACATE_CHECKOUT_API = "https://api.abacatepay.com/v2/checkouts/create";
const { quoteMelhorEnvio } = require("./shipping-quote");

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
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function parsePriceBRL(value) {
  if (typeof value === "number") return value;
  const raw = String(value || "").replace(/[^\d,.-]/g, "");
  if (!raw) return NaN;
  if (raw.includes(",")) return Number(raw.replace(/\./g, "").replace(",", "."));
  const parts = raw.split(".");
  if (parts.length > 1 && parts[parts.length - 1].length === 3) return Number(parts.join(""));
  return Number(raw);
}

function toCents(value) {
  return Math.round(Number(value || 0) * 100);
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
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

function normalizeApiKey(value) {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

function slug(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "item";
}

function paymentMethods() {
  const raw = process.env.ABACATE_PAY_METHODS || "PIX,CARD";
  const allowed = new Set(["PIX", "CARD"]);
  const methods = raw
    .split(",")
    .map((method) => method.trim().toUpperCase())
    .filter((method) => allowed.has(method));
  return methods.length ? [...new Set(methods)] : ["PIX", "CARD"];
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
  if (!option || option.active === false || !label || !Number.isFinite(price) || price <= 0) return null;
  return { ...option, label, price };
}

function productAddonGroups(product, globalAddons = []) {
  const source = product.addons || product.options || {};
  return Object.fromEntries(Object.keys(ADDON_CATEGORIES).map((category) => {
    const globalOptions = Array.isArray(globalAddons)
      ? globalAddons.filter((option) => option?.category === category)
      : [];
    const productOptions = Array.isArray(source[category]) ? source[category] : [];
    const activeOptions = [...globalOptions, ...productOptions].map(normalizeAddonOption).filter(Boolean);
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

function normalizeCheckoutItems(products, globalAddons, payload) {
  const rawCartItems = Array.isArray(payload.cartItems) ? payload.cartItems : [];
  const requestedItems = rawCartItems.length
    ? rawCartItems
    : [{ productId: payload.productId, selectedAddons: payload.selectedAddons }];

  if (!requestedItems.length || !requestedItems[0]?.productId) {
    const error = new Error("Produto nao informado.");
    error.statusCode = 400;
    throw error;
  }

  return requestedItems.map((item) => {
    const productId = String(item?.productId || "");
    const product = products.find((entry) => entry.id === productId && entry.active !== false);
    if (!product) {
      const error = new Error("Produto nao encontrado ou inativo.");
      error.statusCode = 404;
      throw error;
    }

    const unitPrice = parsePriceBRL(product.price);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      const error = new Error("Preco do produto invalido.");
      error.statusCode = 400;
      throw error;
    }

    return {
      product,
      unitPrice,
      addons: normalizeSelectedAddons(product, item.selectedAddons, globalAddons)
    };
  });
}

function aggregateShippingProduct(products) {
  const packages = products.map((product) => {
    const shipping = product.shipping || {};
    return {
      weight: parsePriceBRL(shipping.weightKg) || parsePriceBRL(process.env.DEFAULT_PACKAGE_WEIGHT_KG) || 0,
      height: parsePriceBRL(shipping.heightCm) || parsePriceBRL(process.env.DEFAULT_PACKAGE_HEIGHT_CM) || 0,
      width: parsePriceBRL(shipping.widthCm) || parsePriceBRL(process.env.DEFAULT_PACKAGE_WIDTH_CM) || 0,
      length: parsePriceBRL(shipping.lengthCm) || parsePriceBRL(process.env.DEFAULT_PACKAGE_LENGTH_CM) || 0,
      insuranceValue: parsePriceBRL(shipping.insuranceValue) || parsePriceBRL(product.price) || 1
    };
  });

  return {
    id: "mobilytech-cart",
    title: "Carrinho MobilyTech BR",
    price: packages.reduce((sum, item) => sum + item.insuranceValue, 0) || 1,
    shipping: {
      weightKg: packages.reduce((sum, item) => sum + item.weight, 0) || null,
      heightCm: Math.max(...packages.map((item) => item.height), 0) || null,
      widthCm: Math.max(...packages.map((item) => item.width), 0) || null,
      lengthCm: packages.reduce((sum, item) => sum + item.length, 0) || null,
      insuranceValue: packages.reduce((sum, item) => sum + item.insuranceValue, 0) || 1
    }
  };
}

async function normalizeShipping(product, shipping) {
  if (!shipping || !shipping.postalCode || !shipping.serviceId) return null;
  const quoteResult = await quoteMelhorEnvio(product, shipping.postalCode);
  const selected = quoteResult.quotes.find((quote) => String(quote.id) === String(shipping.serviceId));
  if (!selected) {
    const error = new Error("Frete selecionado nao esta mais disponivel.");
    error.statusCode = 400;
    throw error;
  }

  return {
    ...shipping,
    postalCode: onlyDigits(shipping.postalCode),
    serviceId: String(selected.id),
    serviceName: selected.name,
    carrier: selected.company,
    price: selected.price,
    deliveryTime: selected.deliveryTime
  };
}

async function abacateRequest(apiKey, url, options = {}) {
  const apiResponse = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok || data.success === false || data.error) {
    const detail = typeof data.error === "string"
      ? data.error
      : data.error?.message || data.message;
    const message = [401, 403].includes(apiResponse.status)
      ? "Abacate Pay nao autorizou a chave configurada. Confira se ABACATE_PAY_API_KEY esta correta e com permissoes de Produtos e Checkout."
      : detail || "Abacate Pay recusou a operacao.";
    const error = new Error(message);
    error.statusCode = apiResponse.status || 500;
    error.details = data.error || data;
    throw error;
  }
  return data;
}

async function ensureAbacateProduct(apiKey, line) {
  const payload = {
    externalId: line.externalId,
    name: String(line.name || "Item MobilyTech BR").slice(0, 100),
    description: String(line.description || line.name || "Item MobilyTech BR").slice(0, 300),
    price: toCents(line.price),
    currency: "BRL"
  };
  if (line.imageUrl) payload.imageUrl = line.imageUrl;

  const data = await abacateRequest(apiKey, ABACATE_PRODUCTS_CREATE_API, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const product = data.data || data;
  if (!product?.id) {
    const error = new Error("Abacate Pay criou o produto, mas nao retornou o ID.");
    error.statusCode = 500;
    throw error;
  }
  return product.id;
}

function checkoutLines(checkoutItems, normalizedShipping, origin) {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const lines = checkoutItems.flatMap((item) => {
    const productImage = absoluteUrl(origin, item.product.image || item.product.cutout);
    return [
      {
        externalId: `mobilytech-${runId}-product-${slug(item.product.id)}-${toCents(item.unitPrice)}`,
        name: item.product.title || "PC MobilyTech BR",
        description: item.product.tags?.filter(Boolean).join(" | ") || item.product.title || "PC MobilyTech BR",
        price: item.unitPrice,
        imageUrl: productImage
      },
      ...item.addons.map((addon) => ({
        externalId: `mobilytech-${runId}-addon-${slug(item.product.id)}-${slug(addon.category)}-${slug(addon.label)}-${toCents(addon.price)}`,
        name: `${addon.categoryLabel}: ${addon.label}`,
        description: `${item.product.title} - ${addon.categoryLabel}: ${addon.label}`,
        price: addon.price
      }))
    ];
  });

  if (normalizedShipping) {
    lines.push({
      externalId: `mobilytech-${runId}-shipping-${slug(normalizedShipping.carrier)}-${slug(normalizedShipping.serviceName)}-${toCents(normalizedShipping.price)}`,
      name: `Frete ${normalizedShipping.carrier} ${normalizedShipping.serviceName}`,
      description: `Entrega para CEP ${normalizedShipping.postalCode}`,
      price: normalizedShipping.price
    });
  }

  return lines;
}

module.exports = async function createAbacateCheckout(request, response) {
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

  const apiKey = normalizeApiKey(process.env.ABACATE_PAY_API_KEY || process.env.ABACATEPAY_API_KEY || process.env.ABACATE_PAY_TOKEN);
  if (!apiKey) {
    sendJson(response, 500, { error: "ABACATE_PAY_API_KEY nao configurado na Vercel." });
    return;
  }

  try {
    const payload = await readJsonBody(request);
    const { shipping } = payload;
    const [products, globalAddons] = await Promise.all([loadProducts(), loadGlobalAddons()]);
    const checkoutItems = normalizeCheckoutItems(products, globalAddons, payload);
    const shippingProduct = checkoutItems.length === 1
      ? checkoutItems[0].product
      : aggregateShippingProduct(checkoutItems.map((item) => item.product));
    const normalizedShipping = await normalizeShipping(shippingProduct, shipping);
    const origin = requestOrigin(request);
    const lines = checkoutLines(checkoutItems, normalizedShipping, origin);

    const productIds = [];
    for (const line of lines) {
      productIds.push(await ensureAbacateProduct(apiKey, line));
    }

    const externalId = `mobilytech-checkout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const checkoutPayload = {
      externalId,
      items: productIds.map((productId) => ({ id: productId, quantity: 1 })),
      methods: paymentMethods(),
      card: {
        maxInstallments: Number(process.env.ABACATE_PAY_MAX_INSTALLMENTS || 12)
      },
      returnUrl: `${origin}/pagamento-pendente.html`,
      completionUrl: `${origin}/pagamento-sucesso.html`,
      metadata: {
        checkoutType: checkoutItems.length > 1 ? "cart" : "single_product",
        productId: checkoutItems[0].product.id,
        productIds: checkoutItems.map((item) => item.product.id).join("; "),
        productTitles: checkoutItems.map((item) => item.product.title).join("; "),
        selectedAddons: checkoutItems.flatMap((item) => item.addons.map((addon) => `${item.product.id}:${addon.category}:${addon.label}`)).join("; "),
        shippingRequested: normalizedShipping ? "true" : "false",
        shippingProvider: normalizedShipping ? "melhor-envio" : "",
        shippingServiceId: normalizedShipping?.serviceId || "",
        shippingServiceName: normalizedShipping?.serviceName || "",
        shippingCarrier: normalizedShipping?.carrier || "",
        shippingPrice: normalizedShipping ? String(normalizedShipping.price) : "",
        shippingPostalCode: normalizedShipping?.postalCode || "",
        shippingCustomer: normalizedShipping ? JSON.stringify(normalizedShipping.customer || {}) : ""
      }
    };

    const data = await abacateRequest(apiKey, ABACATE_CHECKOUT_API, {
      method: "POST",
      body: JSON.stringify(checkoutPayload)
    });
    const checkout = data.data || data;
    const checkoutUrl = checkout.url || checkout.checkoutUrl || checkout.initPoint;
    if (!checkoutUrl) {
      sendJson(response, 500, { error: "Abacate Pay nao retornou a URL do checkout.", details: checkout });
      return;
    }

    sendJson(response, 200, {
      id: checkout.id,
      checkout_url: checkoutUrl,
      external_id: externalId
    });
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error.message || "Erro ao criar checkout Abacate Pay.",
      details: error.details
    });
  }
};
