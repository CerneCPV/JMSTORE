// Netlify Function: recebe a notificação (webhook) do Mercado Pago quando
// um pagamento é criado/atualizado, confirma o status direto na API do MP
// (nunca confia nos dados que vêm no corpo da notificação) e, se estiver
// aprovado, manda um WhatsApp avisando o que foi vendido.

exports.handler = async (event) => {
  // O Mercado Pago aceita 200 pra qualquer verbo/formato de teste, então
  // devolvemos sempre 200 pra ele não ficar reenviando em loop — erros são
  // só logados.
  try {
    if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
      return { statusCode: 200, body: 'ok' };
    }

    const qs = event.queryStringParameters || {};
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) { /* pode vir vazio em teste */ }

    // O ID do pagamento pode vir no corpo (notificações novas) ou na query
    // string (formato antigo "IPN").
    const paymentId = body?.data?.id || qs['data.id'] || qs.id;
    const topic = body?.type || body?.topic || qs.type || qs.topic;

    if (!paymentId || (topic && topic !== 'payment')) {
      return { statusCode: 200, body: 'ignorado' };
    }

    // Busca os dados reais do pagamento na API do Mercado Pago — é o único
    // jeito confiável de saber o status, nunca confie em nada que vem
    // direto na notificação.
    const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    });
    const payment = await mpResp.json();

    if (!mpResp.ok || !payment || payment.status !== 'approved') {
      return { statusCode: 200, body: 'status nao aprovado, ignorado' };
    }

    const itens = (payment.additional_info?.items || [])
      .map(i => `• ${i.quantity}x ${i.title} — R$ ${Number(i.unit_price).toFixed(2)}`)
      .join('\n');

    const nomeCliente = payment.payer?.first_name
      ? `${payment.payer.first_name} ${payment.payer.last_name || ''}`.trim()
      : (payment.payer?.email || 'Cliente não identificado');

    const total = Number(payment.transaction_amount || 0).toFixed(2);

    const texto =
      `✅ *Nova venda aprovada!*\n\n` +
      `Cliente: ${nomeCliente}\n` +
      `Total: R$ ${total}\n\n` +
      `Itens:\n${itens || '(sem detalhe de itens)'}\n\n` +
      `Pagamento #${paymentId}`;

    await enviarWhatsapp(texto);

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('Erro no webhook do Mercado Pago:', err);
    return { statusCode: 200, body: 'erro tratado' };
  }
};

async function enviarWhatsapp(texto) {
  const phone = process.env.CALLMEBOT_PHONE;   // seu número com DDI, ex: 5512999999999
  const apikey = process.env.CALLMEBOT_APIKEY; // apikey que o CallMeBot te manda

  if (!phone || !apikey) {
    console.error('CALLMEBOT_PHONE / CALLMEBOT_APIKEY não configurados nas variáveis de ambiente da Netlify.');
    return;
  }

  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(texto)}&apikey=${encodeURIComponent(apikey)}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    console.error('Falha ao enviar WhatsApp via CallMeBot:', resp.status, await resp.text());
  }
}
