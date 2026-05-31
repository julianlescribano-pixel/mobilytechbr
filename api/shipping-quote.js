const fs = require("fs/promises");
const path = require("path");

const PRODUCTS_FILE = path.join(process.cwd(), "data", "products.json");
const MELHOR_ENVIO_API = process.env.MELHOR_ENVIO_API_BASE || "https://www.melhorenvio.com.br/api/v2";

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

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function parsePositiveNumber(value) {
  const number = Number(String(value || "").replace(",", "."));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function allowedCarrierNames() {
  const raw = process.env.SHIPPING_ALLOWED_CARRIERS || "correios,jadlog,loggi";
  return raw.split(",").map(normalizeText).map((item) => item.trim()).filter(Boolean);
}

function isAllowedCarrier(company) {
  const allowed = allowedCarrierNames();
  if (!allowed.length) return true;
  const normalized = normalizeText(company);
  return allowed.some((name) => normalized.includes(name));
}

function isPreferredCarrier(company) {
  const preferred = normalizeText(process.env.SHIPPING_PREFERRED_CARRIER || "correios");
  return preferred ? normalizeText(company).includes(preferred) : false;
}

function productPackage(product) {
  const shipping = product.shipping || {};
  return {
    weight: parsePositiveNumber(shipping.weightKg) || parsePositiveNumber(process.env.DEFAULT_PACKAGE_WEIGHT_KG),
    height: parsePositiveNumber(shipping.heightCm) || parsePositiveNumber(process.env.DEFAULT_PACKAGE_HEIGHT_CM),
    width: parsePositiveNumber(shipping.widthCm) || parsePositiveNumber(process.env.DEFAULT_PACKAGE_WIDTH_CM),
    length: parsePositiveNumber(shipping.lengthCm) || parsePositiveNumber(process.env.DEFAULT_PACKAGE_LENGTH_CM),
    insuranceValue: parsePositiveNumber(shipping.insuranceValue) || parsePositiveNumber(product.price) || 1
  };
}

function aggregatePackage(products) {
  const packages = products.map(productPackage);
  const weight = packages.reduce((sum, item) => sum + (item.weight || 0), 0);
  const length = packages.reduce((sum, item) => sum + (item.length || 0), 0);
  const height = Math.max(...packages.map((item) => item.height || 0));
  const width = Math.max(...packages.map((item) => item.width || 0));
  const insuranceValue = packages.reduce((sum, item) => sum + (item.insuranceValue || 0), 0);
  return {
    id: "mobilytech-cart",
    price: insuranceValue || 1,
    shipping: {
      weightKg: weight || null,
      heightCm: height || null,
      widthCm: width || null,
      lengthCm: length || null,
      insuranceValue: insuranceValue || 1
    }
  };
}

function normalizeQuote(service) {
  const price = parsePositiveNumber(service.custom_price || service.price);
  if (!price || service.error) return null;
  const company = service.company?.name || service.company_name || "";
  if (!isAllowedCarrier(company)) return null;
  return {
    id: String(service.id || service.service_id || ""),
    name: service.name || service.service || "Frete",
    company,
    price,
    deliveryTime: service.custom_delivery_time || service.delivery_time || null,
    recommended: isPreferredCarrier(company),
    raw: {
      id: service.id,
      name: service.name,
      company: service.company,
      price: service.price,
      custom_price: service.custom_price,
      delivery_time: service.delivery_time,
      custom_delivery_time: service.custom_delivery_time
    }
  };
}

async function loadProducts() {
  const products = JSON.parse(await fs.readFile(PRODUCTS_FILE, "utf8"));
  return Array.isArray(products) ? products : [];
}

function productsFromCartItems(products, cartItems) {
  if (!Array.isArray(cartItems) || cartItems.length === 0) return [];
  const requestedIds = cartItems.map((item) => String(item?.productId || "")).filter(Boolean);
  return requestedIds.map((id) => products.find((item) => item.id === id && item.active !== false)).filter(Boolean);
}

async function quoteMelhorEnvio(product, destinationPostalCode) {
  const token = process.env.MELHOR_ENVIO_TOKEN;
  const fromPostalCode = onlyDigits(process.env.SHIP_FROM_POSTAL_CODE);
  const toPostalCode = onlyDigits(destinationPostalCode);
  if (!token || !fromPostalCode) {
    const error = new Error("Frete automatico ainda nao configurado.");
    error.statusCode = 501;
    throw error;
  }
  if (toPostalCode.length !== 8) {
    const error = new Error("CEP de destino invalido.");
    error.statusCode = 400;
    throw error;
  }

  const pkg = productPackage(product);
  if (!pkg.weight || !pkg.height || !pkg.width || !pkg.length) {
    const error = new Error("Peso e medidas da caixa ainda nao foram configurados.");
    error.statusCode = 400;
    throw error;
  }

  const body = {
    from: { postal_code: fromPostalCode },
    to: { postal_code: toPostalCode },
    products: [{
      id: product.id,
      width: pkg.width,
      height: pkg.height,
      length: pkg.length,
      weight: pkg.weight,
      insurance_value: pkg.insuranceValue,
      quantity: 1
    }],
    options: {
      receipt: false,
      own_hand: false,
      collect: false
    }
  };

  const apiResponse = await fetch(`${MELHOR_ENVIO_API}/me/shipment/calculate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": process.env.MELHOR_ENVIO_USER_AGENT || "MobilyTechBR (mobilytechbr@gmail.com)"
    },
    body: JSON.stringify(body)
  });

  const data = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) {
    const error = new Error(data.message || "Nao foi possivel calcular o frete.");
    error.statusCode = apiResponse.status;
    error.details = data;
    throw error;
  }

  const quotes = (Array.isArray(data) ? data : [])
    .map(normalizeQuote)
    .filter(Boolean)
    .sort((a, b) => {
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return a.price - b.price;
    });

  return { quotes, package: pkg };
}

module.exports = async function shippingQuote(request, response) {
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

  try {
    const { productId, cartItems, postalCode } = await readJsonBody(request);
    const products = await loadProducts();
    const hasCart = Array.isArray(cartItems) && cartItems.length > 0;
    const cartProducts = productsFromCartItems(products, cartItems);
    if (hasCart && cartProducts.length !== cartItems.length) {
      sendJson(response, 404, { error: "Um ou mais produtos do carrinho nao estao disponiveis." });
      return;
    }
    const product = cartProducts.length
      ? aggregatePackage(cartProducts)
      : products.find((item) => item.id === productId && item.active !== false);
    if (!product) {
      sendJson(response, 404, { error: "Produto nao encontrado ou inativo." });
      return;
    }

    const result = await quoteMelhorEnvio(product, postalCode);
    if (!result.quotes.length) {
      sendJson(response, 404, { error: "Nenhuma opcao de frete disponivel para esse CEP." });
      return;
    }

    sendJson(response, 200, {
      productId: cartProducts.length ? "cart" : productId,
      postalCode: onlyDigits(postalCode),
      provider: "melhor-envio",
      quotes: result.quotes
    });
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error.message || "Erro ao calcular frete.",
      details: error.details
    });
  }
};

module.exports.quoteMelhorEnvio = quoteMelhorEnvio;
