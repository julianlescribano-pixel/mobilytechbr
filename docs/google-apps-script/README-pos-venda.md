# Pos-venda MobilyTech BR

Este arquivo deixa pronto o caminho de pos-venda por Google Apps Script.

## Arquivos

- `mobilytech-pos-venda.gs`: cole no Apps Script de uma planilha.
- `data/automation-settings.json`: aparece no painel do site para ligar/desligar automacoes.

## Setup recomendado

1. Crie uma planilha no Google Sheets.
2. Abra `Extensoes > Apps Script`.
3. Cole o conteudo de `mobilytech-pos-venda.gs`.
4. Troque `COLE_AQUI_O_ID_DA_PLANILHA` pelo ID da planilha.
5. Rode `setupMobilyTechPostSale()` uma vez.
6. Publique como Web App.
7. Na Vercel, configure `ORDER_NOTIFICATION_ENDPOINT` com a URL do Web App.
8. Na Vercel, configure `ORDER_CONFIRMATION_SECRET` com uma frase forte qualquer para assinar os links de confirmacao de etiqueta.
9. No painel do Abacate Pay, configure o webhook para:

`https://mobilytechbr.vercel.app/api/abacate-pay-webhook`

O Mercado Pago continua usando o webhook proprio que ja esta configurado no projeto.

## Como funciona

- Quando o Mercado Pago ou Abacate Pay confirmar uma venda, o webhook envia os dados para o Apps Script.
- O Apps Script salva o pedido na aba `Pedidos`.
- A cada 5 minutos, ele envia:
  - e-mail de compra confirmada para o cliente;
  - e-mail interno para `mobilytechbr@gmail.com`;
  - e-mail de rastreio quando a coluna `CodigoRastreio` for preenchida e o status virar `DESPACHADO`;
  - e-mail de entrega quando o status virar `ENTREGUE`.

## Etiqueta do Melhor Envio

O e-mail interno inclui o link `Confirmar etiqueta` quando a venda tiver frete.

Por seguranca, a compra automatica de etiqueta continua dependendo da variavel:

`MELHOR_ENVIO_ENABLE_LABEL_PURCHASE=true`

Se voce negar a etiqueta pelo link do Apps Script, o pedido fica marcado como `CANCELAR` e `ReembolsoManual = Pendente`.

## Transportadoras no checkout

O checkout consulta o Melhor Envio e aceita, por padrao, cotacoes de:

`correios,jadlog,loggi`

O Correios aparece como opcao recomendada quando estiver disponivel. Para trocar a lista sem mexer no codigo, use estas variaveis na Vercel:

- `SHIPPING_ALLOWED_CARRIERS`: lista separada por virgula, por exemplo `correios,jadlog,loggi`.
- `SHIPPING_PREFERRED_CARRIER`: transportadora recomendada, por exemplo `correios`.

## Sincronizacao de precos

A automacao de precos fica desligada por padrao e em modo `review`.

Motivo: Facebook Marketplace e OLX podem exigir login, mudar pagina ou mostrar anuncios parecidos. Para nao alterar o PC errado, o primeiro passo e gerar uma aba de revisao. Depois de alguns testes com confianca alta, da para evoluir para aplicacao automatica via GitHub API.
