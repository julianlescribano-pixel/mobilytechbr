const fs = require("fs/promises");
const path = require("path");

const PRODUCTS_FILE = path.join(process.cwd(), "data", "products.json");
const ADDONS_FILE = path.join(process.cwd(), "data", "addons.json");
const ABACATE_PIX_API = "https://api.abacatepay.com/v1/pixQrCode/create";
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

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
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

function totalFromCheckoutItems(checkoutItems, normalizedShipping) {
  const productsTotal = checkoutItems.reduce((sum, item) => {
    const addonsTotal = item.addons.reduce((addonSum, addon) => addonSum + addon.price, 0);
    return sum + item.unitPrice + addonsTotal;
  }, 0);
  return productsTotal + (normalizedShipping ? normalizedShipping.price : 0);
}

function toCents(value) {
  return Math.round(Number(value || 0) * 100);
}

function buildDescription(checkoutItems) {
  if (checkoutItems.length === 1) {
    return String(checkoutItems[0].product.title || "Pedido MobilyTech BR").slice(0, 37);
  }
  return "Carrinho MobilyTech BR";
}

module.exports = async function createAbacatePix(request, response) {
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

  const apiKey = process.env.ABACATE_PAY_API_KEY || process.env.ABACATEPAY_API_KEY || process.env.ABACATE_PAY_TOKEN;
  if (!apiKey) {
    sendJson(response, 500, { error: "ABACATE_PAY_API_KEY nao configurado na Vercel." });
    return;
  }

  try {
    const payload = await readJsonBody(request);
    const { shipping } = payload;
    const [products, globalAddons] = await Promise.all([
      loadProducts(),
      loadGlobalAddons()
    ]);
    const checkoutItems = normalizeCheckoutItems(products, globalAddons, payload);
    const shippingProduct = checkoutItems.length === 1
      ? checkoutItems[0].product
      : aggregateShippingProduct(checkoutItems.map((item) => item.product));
    const normalizedShipping = await normalizeShipping(shippingProduct, shipping);
    const total = totalFromCheckoutItems(checkoutItems, normalizedShipping);
    const amount = toCents(total);

    if (!Number.isInteger(amount) || amount <= 0) {
      sendJson(response, 400, { error: "Valor do pedido invalido." });
      return;
    }

    const externalId = `mobilytech-${Date.now()}`;
    const selectedAddons = checkoutItems.flatMap((item) => item.addons.map((addon) => `${item.product.id}:${addon.category}:${addon.label}`));
    const pixPayload = {
      amount,
      expiresIn: Number(process.env.ABACATE_PAY_PIX_EXPIRES_IN_SECONDS || 3600),
      description: buildDescription(checkoutItems),
      metadata: {
        externalId,
        checkoutType: checkoutItems.length > 1 ? "cart" : "single_product",
        productIds: checkoutItems.map((item) => item.product.id).join("; "),
        productTitles: checkoutItems.map((item) => item.product.title).join("; "),
        selectedAddons: selectedAddons.join("; "),
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

    const abacateResponse = await fetch(ABACATE_PIX_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(pixPayload)
    });

    const data = await abacateResponse.json().catch(() => ({}));
    if (!abacateResponse.ok || data.error || !data.data?.brCode) {
      sendJson(response, abacateResponse.status || 500, {
        error: data.error?.message || data.message || "Abacate Pay recusou a criacao do Pix.",
        details: data.error || data
      });
      return;
    }

    sendJson(response, 200, {
      id: data.data.id,
      amount: data.data.amount,
      amount_brl: total,
      copy_code: data.data.brCode,
      qr_code_base64: data.data.brCodeBase64,
      expires_at: data.data.expiresAt,
      external_id: externalId
    });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error.message || "Erro ao criar Pix Abacate Pay." });
  }
};
