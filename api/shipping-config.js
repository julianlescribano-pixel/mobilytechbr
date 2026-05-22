function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

function hasDefaultPackage() {
  return Boolean(
    process.env.DEFAULT_PACKAGE_WEIGHT_KG &&
    process.env.DEFAULT_PACKAGE_HEIGHT_CM &&
    process.env.DEFAULT_PACKAGE_WIDTH_CM &&
    process.env.DEFAULT_PACKAGE_LENGTH_CM
  );
}

module.exports = async function shippingConfig(_request, response) {
  const enabled = Boolean(
    process.env.MELHOR_ENVIO_TOKEN &&
    process.env.SHIP_FROM_POSTAL_CODE &&
    hasDefaultPackage()
  );

  sendJson(response, 200, {
    enabled,
    provider: "melhor-envio",
    preferredCarrier: "Correios",
    requires: enabled ? [] : [
      "MELHOR_ENVIO_TOKEN",
      "SHIP_FROM_POSTAL_CODE",
      "DEFAULT_PACKAGE_WEIGHT_KG",
      "DEFAULT_PACKAGE_HEIGHT_CM",
      "DEFAULT_PACKAGE_WIDTH_CM",
      "DEFAULT_PACKAGE_LENGTH_CM"
    ]
  });
};
