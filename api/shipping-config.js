function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

const REQUIRED_ENV = [
  "MELHOR_ENVIO_TOKEN",
  "SHIP_FROM_POSTAL_CODE",
  "DEFAULT_PACKAGE_WEIGHT_KG",
  "DEFAULT_PACKAGE_HEIGHT_CM",
  "DEFAULT_PACKAGE_WIDTH_CM",
  "DEFAULT_PACKAGE_LENGTH_CM"
];

function hasEnvValue(name) {
  return Boolean(String(process.env[name] || "").trim());
}

module.exports = async function shippingConfig(_request, response) {
  const missing = REQUIRED_ENV.filter((name) => !hasEnvValue(name));
  const enabled = missing.length === 0;

  sendJson(response, 200, {
    enabled,
    provider: "melhor-envio",
    preferredCarrier: process.env.SHIPPING_PREFERRED_CARRIER || "Correios",
    allowedCarriers: process.env.SHIPPING_ALLOWED_CARRIERS || "correios,jadlog,loggi",
    requires: missing
  });
};
