const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const PRODUCTS_FILE = path.join(process.cwd(), "data", "products.json");
const MERCADO_PAGO_PAYMENT_API = "https://api.mercadopago.com/v1/payments";
const MELHOR_ENVIO_API = process.env.MELHOR_ENVIO_API_BASE || "https://www.melhorenvio.com.br/api/v2";

function html(response, status, title, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#06101b;color:#f5fbff;font-family:Inter,system-ui,sans-serif}.card{max-width:760px;border:1px solid rgba(46,196,255,.28);border-radius:12px;padding:28px;background:#081d30;box-shadow:0 24px 70px rgba(0,0,0,.35)}h1{margin:0 0 12px;font-size:32px}p{color:#a7bdd0;line-height:1.55}code{display:block;white-space:pre-wrap;background:#02070d;border-radius:8px;padding:14px;color:#d7f7ff}</style></head><body><main class="card"><h1>${title}</h1>${body}</main></body></html>`);
}

function verifyToken(token) {
  const secret = process.env.ORDER_CONFIRMATION_SECRET || process.env.MERCADO_PAGO_ACCESS_TOKEN;
  if (!secret || !token || !token.includes(".")) return null;
  const [encoded, signature] = token.split(".");
  const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  const signatureBuffer = Buffer.from(signature || "");
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!payload.expiresAt || Date.now() > payload.expiresAt) return null;
  return payload;
}

function parseNumber(value) {
  const number = Number(String(value || "").replace(",", "."));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

async function loadProducts() {
  const products = JSON.parse(await fs.readFile(PRODUCTS_FILE, "utf8"));
  return Array.isArray(products) ? products : [];
}

async function fetchPayment(paymentId) {
  const token = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  if (!token) throw new Error("MERCADO_PAGO_ACCESS_TOKEN nao configurado.");
  const response = await fetch(`${MERCADO_PAGO_PAYMENT_API}/${paymentId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Nao foi possivel consultar o pagamento.");
  return data;
}

async function assertPaymentConfirmed(payload) {
  if (payload.paymentProvider === "abacate") {
    if (payload.paymentStatus !== "approved") {
      throw new Error("Pagamento Abacate Pay ainda nao confirmado.");
    }
    return {
      id: payload.paymentId,
      status: "approved",
      provider: "abacate"
    };
  }

  const payment = await fetchPayment(payload.paymentId);
  if (payment.status !== "approved") {
    const error = new Error(`Pagamento nao aprovado. Status atual: ${payment.status || "desconhecido"}.`);
    error.statusCode = 409;
    throw error;
  }
  return payment;
}

function productPackage(product) {
  const shipping = product.shipping || {};
  return {
    weight: parseNumber(shipping.weightKg) || parseNumber(process.env.DEFAULT_PACKAGE_WEIGHT_KG),
    height: parseNumber(shipping.heightCm) || parseNumber(process.env.DEFAULT_PACKAGE_HEIGHT_CM),
    width: parseNumber(shipping.widthCm) || parseNumber(process.env.DEFAULT_PACKAGE_WIDTH_CM),
    length: parseNumber(shipping.lengthCm) || parseNumber(process.env.DEFAULT_PACKAGE_LENGTH_CM),
    insuranceValue: parseNumber(shipping.insuranceValue) || parseNumber(product.price) || 1
  };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Configure ${name} na Vercel antes de comprar etiquetas.`);
  return value;
}

function buildShipment(product, payload) {
  const customer = payload.shipping?.customer || {};
  const pkg = productPackage(product);
  const fromPostalCode = onlyDigits(requireEnv("SHIP_FROM_POSTAL_CODE"));

  return {
    service: Number(payload.shipping.serviceId),
    agency: process.env.MELHOR_ENVIO_AGENCY_ID ? Number(process.env.MELHOR_ENVIO_AGENCY_ID) : undefined,
    from: {
      name: requireEnv("SHIP_FROM_NAME"),
      phone: onlyDigits(requireEnv("SHIP_FROM_PHONE")),
      email: requireEnv("SHIP_FROM_EMAIL"),
      document: onlyDigits(requireEnv("SHIP_FROM_DOCUMENT")),
      address: requireEnv("SHIP_FROM_STREET"),
      complement: process.env.SHIP_FROM_COMPLEMENT || undefined,
      number: requireEnv("SHIP_FROM_NUMBER"),
      district: requireEnv("SHIP_FROM_DISTRICT"),
      city: requireEnv("SHIP_FROM_CITY"),
      country_id: "BR",
      postal_code: fromPostalCode
    },
    to: {
      name: customer.name,
      phone: onlyDigits(customer.phone),
      email: customer.email,
      document: onlyDigits(customer.document),
      address: customer.street,
      complement: customer.complement || undefined,
      number: customer.number,
      district: customer.district,
      city: customer.city,
      state_abbr: customer.state,
      country_id: "BR",
      postal_code: onlyDigits(payload.shipping.postalCode)
    },
    products: [{
      name: product.title,
      quantity: 1,
      unitary_value: parseNumber(product.price) || 1
    }],
    volumes: [{
      height: pkg.height,
      width: pkg.width,
      length: pkg.length,
      weight: pkg.weight
    }],
    options: {
      insurance_value: pkg.insuranceValue,
      receipt: false,
      own_hand: false,
      reverse: false,
      non_commercial: true
    }
  };
}

async function melhorEnvioRequest(pathname, body) {
  const token = requireEnv("MELHOR_ENVIO_TOKEN");
  const response = await fetch(`${MELHOR_ENVIO_API}${pathname}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": process.env.MELHOR_ENVIO_USER_AGENT || "MobilyTechBR (mobilytechbr@gmail.com)"
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message || data.error || `Melhor Envio retornou erro ${response.status}.`;
    throw new Error(`${message}\n${JSON.stringify(data)}`);
  }
  return data;
}

function extractOrderId(data) {
  if (data?.id) return data.id;
  if (data?.order?.id) return data.order.id;
  if (Array.isArray(data) && data[0]?.id) return data[0].id;
  return null;
}

module.exports = async function shippingConfirm(request, response) {
  try {
    const url = new URL(request.url || "/", `https://${request.headers.host || "mobilytechbr.vercel.app"}`);
    const payload = verifyToken(url.searchParams.get("token"));
    if (!payload) {
      html(response, 400, "Link invalido", "<p>Esse link de confirmacao expirou ou nao e valido.</p>");
      return;
    }

    await assertPaymentConfirmed(payload);

    if (process.env.MELHOR_ENVIO_ENABLE_LABEL_PURCHASE !== "true") {
      html(response, 200, "Confirmacao pronta", "<p>O pedido foi validado, mas a compra automatica da etiqueta ainda esta desativada.</p><p>Ative <strong>MELHOR_ENVIO_ENABLE_LABEL_PURCHASE=true</strong> na Vercel quando quiser permitir que este botao compre a etiqueta de verdade.</p>");
      return;
    }

    const products = await loadProducts();
    const product = products.find((item) => item.id === payload.productId);
    if (!product) throw new Error("Produto nao encontrado no catalogo.");

    const shipment = buildShipment(product, payload);
    const cartData = await melhorEnvioRequest("/me/cart", shipment);
    const orderId = extractOrderId(cartData);
    if (!orderId) throw new Error(`Nao consegui identificar o ID do pedido no Melhor Envio: ${JSON.stringify(cartData)}`);

    const checkoutData = await melhorEnvioRequest("/me/shipment/checkout", { orders: [orderId] });
    const generateData = await melhorEnvioRequest("/me/shipment/generate", { orders: [orderId] });
    const printData = await melhorEnvioRequest("/me/shipment/print", { orders: [orderId] });

    html(response, 200, "Etiqueta comprada", `<p>A compra da etiqueta foi enviada ao Melhor Envio.</p><code>${JSON.stringify({ orderId, checkoutData, generateData, printData }, null, 2)}</code>`);
  } catch (error) {
    html(response, error.statusCode || 500, "Erro ao comprar etiqueta", `<p>Confira os dados e variaveis da Vercel.</p><code>${String(error.message || error)}</code>`);
  }
};
