// Netlify Function: recebe notificações do Mercado Pago
// Confirma se o pagamento foi aprovado e envia uma mensagem
// para o WhatsApp do dono usando CallMeBot.

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
      return {
        statusCode: 200,
        body: 'ok'
      };
    }

    const qs = event.queryStringParameters || {};

    let body = {};

    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      body = {};
    }

    const paymentId =
      body?.data?.id ||
      qs['data.id'] ||
      qs.id;

    const topic =
      body?.type ||
      body?.topic ||
      qs.type ||
      qs.topic;

    console.log('Webhook recebido. Pagamento:', paymentId);

    if (!paymentId) {
      console.log('Webhook sem ID de pagamento.');
      return {
        statusCode: 200,
        body: 'ignorado'
      };
    }

    if (topic && topic !== 'payment') {
      console.log('Notificação ignorada. Tipo:', topic);

      return {
        statusCode: 200,
        body: 'ignorado'
      };
    }

    // Consulta o pagamento diretamente no Mercado Pago
    const mpResp = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`
        }
      }
    );

    const payment = await mpResp.json();

    if (!mpResp.ok) {
      console.error(
        'Erro ao consultar pagamento:',
        payment
      );

      return {
        statusCode: 200,
        body: 'erro ao consultar pagamento'
      };
    }

    if (!payment || payment.status !== 'approved') {
      console.log(
        'Pagamento não aprovado:',
        payment?.status
      );

      return {
        statusCode: 200,
        body: 'pagamento não aprovado'
      };
    }

    console.log(
      'Pagamento aprovado:',
      paymentId
    );

    // ================================
    // DADOS DA VENDA
    // ================================

    const nomeCliente =
      payment.payer?.first_name
        ? `${payment.payer.first_name} ${payment.payer.last_name || ''}`.trim()
        : (
            payment.payer?.email ||
            'Cliente não identificado'
          );

    const total = Number(
      payment.transaction_amount || 0
    ).toFixed(2);

    const itens =
      (payment.additional_info?.items || [])
        .map(item => {
          const quantidade =
            Number(item.quantity || 1);

          const preco =
            Number(item.unit_price || 0)
              .toFixed(2);

          return `• ${quantidade}x ${item.title} — R$ ${preco}`;
        })
        .join('\n');

    const texto =
      `✅ *NOVA VENDA APROVADA!*\n\n` +
      `Cliente: ${nomeCliente}\n` +
      `Total: R$ ${total}\n\n` +
      `Itens:\n` +
      `${itens || '(sem detalhes dos itens)'}\n\n` +
      `Pagamento #${paymentId}`;

    // ================================
    // ENVIA WHATSAPP
    // ================================

    await enviarWhatsapp(texto);

    return {
      statusCode: 200,
      body: 'ok'
    };

  } catch (err) {

    console.error(
      'Erro no webhook do Mercado Pago:',
      err
    );

    // Sempre retorna 200 para evitar
    // reenvios excessivos do Mercado Pago.
    return {
      statusCode: 200,
      body: 'erro tratado'
    };
  }
};


// ========================================
// CALLMEBOT
// ========================================

async function enviarWhatsapp(texto) {

  const phone =
    process.env.CALLMEBOT_PHONE;

  const apikey =
    process.env.CALLMEBOT_APIKEY;

  if (!phone || !apikey) {

    console.error(
      'CALLMEBOT_PHONE ou CALLMEBOT_APIKEY não configurados.'
    );

    return;
  }

  console.log(
    'Enviando WhatsApp para:',
    phone
  );

  const url =
    `https://api.callmebot.com/whatsapp.php` +
    `?phone=${encodeURIComponent(phone)}` +
    `&text=${encodeURIComponent(texto)}` +
    `&apikey=${encodeURIComponent(apikey)}`;

  try {

    const resp = await fetch(url);

    const resposta =
      await resp.text();

    if (!resp.ok) {

      console.error(
        'Falha ao enviar WhatsApp via CallMeBot:',
        resp.status,
        resposta
      );

      return;
    }

    console.log(
      'WhatsApp enviado pelo CallMeBot:',
      resposta
    );

  } catch (err) {

    console.error(
      'Erro ao chamar CallMeBot:',
      err
    );
  }
}
