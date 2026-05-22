# Frete e pos-venda com Melhor Envio

Este site ja tem a base para calcular frete pelos Correios via Melhor Envio, somar o frete no Checkout Pro do Mercado Pago e enviar um e-mail de pos-venda com link de confirmacao da etiqueta.

## Variaveis obrigatorias na Vercel

Para habilitar o calculo de frete no site:

- `MELHOR_ENVIO_TOKEN`
- `SHIP_FROM_POSTAL_CODE`
- `DEFAULT_PACKAGE_WEIGHT_KG`
- `DEFAULT_PACKAGE_HEIGHT_CM`
- `DEFAULT_PACKAGE_WIDTH_CM`
- `DEFAULT_PACKAGE_LENGTH_CM`

Para o link de confirmacao comprar a etiqueta de verdade:

- `MELHOR_ENVIO_ENABLE_LABEL_PURCHASE=true`
- `ORDER_CONFIRMATION_SECRET`
- `SHIP_FROM_NAME`
- `SHIP_FROM_PHONE`
- `SHIP_FROM_EMAIL`
- `SHIP_FROM_DOCUMENT`
- `SHIP_FROM_STREET`
- `SHIP_FROM_NUMBER`
- `SHIP_FROM_DISTRICT`
- `SHIP_FROM_CITY`

Opcionais:

- `SHIP_FROM_COMPLEMENT`
- `MELHOR_ENVIO_API_BASE`
- `MELHOR_ENVIO_USER_AGENT`
- `MELHOR_ENVIO_AGENCY_ID`
- `ORDER_NOTIFICATION_ENDPOINT`
- `MERCADO_PAGO_WEBHOOK_URL`

## Fluxo

1. Se as variaveis do Melhor Envio nao estiverem configuradas, o botao do Mercado Pago continua funcionando como antes.
2. Se estiverem configuradas, o cliente informa os dados de entrega.
3. O site calcula as opcoes dos Correios pelo Melhor Envio.
4. O frete selecionado entra como item separado no Checkout Pro.
5. Quando o Mercado Pago aprova o pagamento, o webhook envia um e-mail com resumo do pedido e link de confirmacao da etiqueta.
6. O link so compra etiqueta se `MELHOR_ENVIO_ENABLE_LABEL_PURCHASE=true` estiver ativo.

Comece testando sem `MELHOR_ENVIO_ENABLE_LABEL_PURCHASE=true`. Depois que as cotacoes e os dados estiverem corretos, ative a compra real.
