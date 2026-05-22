const crypto = require("crypto");

const MERCADO_PAGO_PAYMENT_API = "https://api.mercadopago.com/v1/payments";
const DEFAULT_ORDER_ENDPOINT = "https://formspree.io/f/mnjrqypq";

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body || "{}");

  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function requestOrigin(request) {
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  const protocol = request.headers["x-forwarded-proto"] || "https";
  return process.env.SITE_URL || `${protocol}://${host}`;
}

function extractPaymentId(request, body) {
  const url = new URL(request.url || "/", requestOrigin(request));
  return (
    body?.data?.id ||
    body?.id ||
    url.searchParams.get("data.id") ||
    url.searchParams.get("id")
  );
}

function signPayload(payload) {
  const secret = process.env.ORDER_CONFIRMATION_SECRET || process.env.MERCADO_PAGO_ACCESS_TOKEN;
  if (!secret) return "";

  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

async function fetchPayment(paymentId) {
  const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  if (!accessToken) {
    const error = new Error("MERCADO_PAGO_ACCESS_TOKEN nao configurado.");
    error.statusCode = 500;
    throw error;
  }

  const response = await fetch(`${MERCADO_PAGO_PAYMENT_API}/${paymentId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || "Nao foi possivel consultar o pagamento.");
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

async function notifyOrder(request, payment) {
  const endpoint = process.env.ORDER_NOTIFICATION_ENDPOINT || DEFAULT_ORDER_ENDPOINT;
  if (!endpoint) return { sent: false };

  const metadata = payment.metadata || {};
  const shippingCustomer = metadata.shipping_customer ? JSON.parse(metadata.shipping_customer) : {};
  const origin = requestOrigin(request);
  const confirmationToken = signPayload({
    paymentId: payment.id,
    productId: metadata.product_id,
    productTitle: metadata.product_title,
    shipping: {
      provider: metadata.shipping_provider,
      serviceId: metadata.shipping_service_id,
      serviceName: metadata.shipping_service_name,
      carrier: metadata.shipping_carrier,
      price: metadata.shipping_price,
      postalCode: metadata.shipping_postal_code,
      customer: shippingCustomer
    },
    expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7
  });
  const confirmationUrl = confirmationToken
    ? `${origin}/api/shipping-confirm?token=${encodeURIComponent(confirmationToken)}`
    : "";

  const lines = [
    "Novo pedido pago no Mercado Pago.",
    "",
    `Pagamento: ${payment.id}`,
    `Produto: ${metadata.product_title || payment.description || ""}`,
    `Opcionais: ${metadata.selected_addons || "Nenhum"}`,
    `Valor pago: R$ ${payment.transaction_amount}`,
    "",
    "Entrega:",
    `Transportadora: ${metadata.shipping_carrier || "Nao informado"}`,
    `Servico: ${metadata.shipping_service_name || "Nao informado"}`,
    `Frete: R$ ${metadata.shipping_price || "0"}`,
    `CEP: ${metadata.shipping_postal_code || shippingCustomer.postalCode || ""}`,
    `Cliente: ${shippingCustomer.name || ""}`,
    `Email: ${shippingCustomer.email || payment.payer?.email || ""}`,
    `Telefone: ${shippingCustomer.phone || ""}`,
    `Endereco: ${[shippingCustomer.street, shippingCustomer.number, shippingCustomer.complement, shippingCustomer.district, shippingCustomer.city, shippingCustomer.state].filter(Boolean).join(", ")}`,
    "",
    confirmationUrl ? `Confirmar compra da etiqueta: ${confirmationUrl}` : "Confirmacao de etiqueta indisponivel: configure ORDER_CONFIRMATION_SECRET."
  ];

  const form = new URLSearchParams({
    _subject: "Pedido pago - MobilyTechBR",
    email: shippingCustomer.email || payment.payer?.email || "mobilyfinds@gmail.com",
    mensagem: lines.join("\n"),
    pagamento: String(payment.id),
    produto: metadata.product_title || "",
    confirmar_etiqueta: confirmationUrl
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  return { sent: response.ok, status: response.status };
}

module.exports = async function mercadoPagoWebhook(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Metodo nao permitido." });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const paymentId = extractPaymentId(request, body);
    if (!paymentId) {
      sendJson(response, 200, { ok: true, ignored: "missing_payment_id" });
      return;
    }

    const payment = await fetchPayment(paymentId);
    if (payment.status !== "approved") {
      sendJson(response, 200, { ok: true, status: payment.status });
      return;
    }

    const metadata = payment.metadata || {};
    if (metadata.shipping_requested !== "true") {
      sendJson(response, 200, { ok: true, status: "approved_without_shipping" });
      return;
    }

    const notification = await notifyOrder(request, payment);
    sendJson(response, 200, { ok: true, paymentId, notification });
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error.message || "Erro no webhook do Mercado Pago.",
      details: error.details
    });
  }
};
